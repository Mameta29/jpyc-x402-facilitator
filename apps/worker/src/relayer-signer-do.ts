/**
 * RelayerSignerDO — Durable Object that owns one relayer wallet's broadcast
 * lane on a single chain.
 *
 * Why a DO at all:
 *
 *   In a Workers deployment, requests can be served by many isolates in
 *   parallel. If two settle requests for the same chain race to read the
 *   pending nonce and broadcast, viem may pick the same nonce N for both
 *   txs and the second one will revert. We need a single serialization
 *   point per (chain, relayer wallet).
 *
 *   `blockConcurrencyWhile` inside a DO is exactly that primitive — Cloudflare
 *   guarantees only one async callback runs at a time inside a single DO
 *   instance.
 *
 * Why broadcast-only inside the lock:
 *
 *   `blockConcurrencyWhile` has a hard 30 s timeout — if the callback runs
 *   longer the DO is reset. Polygon receipt is ~3 s but Ethereum mainnet
 *   can comfortably blow past 30 s under load. We therefore restrict the
 *   serialised section to nonce-fetch + broadcast (sub-second), and let
 *   the parent Worker await receipts in parallel.
 *
 *   Safety: viem's writeContract reads `eth_getTransactionCount({blockTag:
 *   "pending"})` before signing, which counts broadcast-but-unmined txs.
 *   So tx N+1 can be safely broadcast as soon as tx N has been *broadcast*,
 *   not when it has *mined*.
 *
 * Sharding:
 *
 *   We pick one DO per chain. If JPYC volume ever needs more throughput per
 *   chain, we can shard by hashing the payer address into N DOs per chain,
 *   each owning a sub-pool of nonces. Today: one DO per chain is plenty.
 */

import { DurableObject } from "cloudflare:workers"
import { type Address, type Hex, createWalletClient, fallback, http } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import {
  JPYC_ABI,
  checkTimeWindow,
  isRelayerGasExhaustionError,
  parseEip3009RevertReason,
  splitSignatureComponents,
  resolveViemChain,
} from "@jpyc-x402/evm"
import { FACILITATOR_INTERNAL_ERROR_CODES, X402_ERROR_CODES, getJpycChain } from "@jpyc-x402/shared"
import type { WorkerEnv } from "./env"

export interface DoBroadcastInput {
  chainId: number
  payer: Address
  payTo: Address
  /** Atomic units, decimal string (DO RPC strips bigint serialization). */
  valueAtomic: string
  validAfter: string
  validBefore: string
  nonce: Hex
  signature: Hex
}

export interface DoBroadcastOk {
  ok: true
  txHash: Hex
  /**
   * true when this (payer, nonce) was already broadcast by a previous request
   * and the stored txHash is being replayed instead of re-broadcasting.
   * Cross-isolate safe: the record lives in DO storage, not isolate memory.
   */
  replayed?: boolean
}
export interface DoBroadcastFail {
  ok: false
  reason: string
}
export type DoBroadcastResult = DoBroadcastOk | DoBroadcastFail

/**
 * Persistent record of a broadcast, kept in DO storage. This is the
 * cross-isolate idempotency layer the in-memory NonceCache cannot provide:
 * a retry landing on a different isolate (or after an isolate restart) still
 * finds the txHash here instead of double-broadcasting / returning a bogus
 * failure for an already-settled payment.
 *
 * Records are pruned after SETTLE_RECORD_TTL_MS — beyond that the contract's
 * `authorizationState` is the (permanent) source of truth.
 */
export interface SettleRecord {
  txHash: Hex
  broadcastAt: number
  chainId: number
  payer: string
  nonce: string
}

const SETTLE_RECORD_TTL_MS = 72 * 60 * 60 * 1000
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000

function settleRecordKey(payer: string, nonce: string): string {
  return `settle:${payer.toLowerCase()}:${nonce.toLowerCase()}`
}

/**
 * One DO instance per (chain, env). The instance id should encode the chain
 * so Cloudflare can route deterministically. The Worker entrypoint resolves:
 *
 *   const id = env.RELAYER.idFromName(`chain-${chainId}`)
 *   const stub = env.RELAYER.get(id)
 *   const result = await stub.broadcast({...})
 */
export class RelayerSignerDO extends DurableObject<WorkerEnv> {
  // Derive the viem Account once per DO instance. `privateKeyToAccount` runs
  // secp256k1 keypair derivation on every call — cheap individually, but this
  // path is on the broadcast hot loop and the key never changes for the life
  // of the isolate.
  private cachedAccount?: ReturnType<typeof privateKeyToAccount>

  private getAccount() {
    if (!this.cachedAccount) {
      this.cachedAccount = privateKeyToAccount(this.env.RELAYER_PRIVATE_KEY as Hex)
    }
    return this.cachedAccount
  }

  /** Last opportunistic prune (isolate-local; prune itself reads storage). */
  private lastPruneAt = 0

  /**
   * Look up the persistent broadcast record for (payer, nonce). Used by the
   * POST /settle-status endpoint so the EC can ask "was this authorization
   * ever broadcast, and with which tx?" after a timed-out settle call.
   * Returns null when unknown — note records expire after 72h, so null does
   * NOT prove no broadcast; on-chain `authorizationState` is authoritative.
   */
  async getSettleRecord(payer: string, nonce: string): Promise<SettleRecord | null> {
    const record = await this.ctx.storage.get<SettleRecord>(settleRecordKey(payer, nonce))
    return record ?? null
  }

  /** Delete records older than SETTLE_RECORD_TTL_MS. Volume is low (one key
   * per settle), so a full prefix list is fine. */
  private async pruneSettleRecords(): Promise<void> {
    const now = Date.now()
    const entries = await this.ctx.storage.list<SettleRecord>({ prefix: "settle:" })
    const stale: string[] = []
    for (const [key, record] of entries) {
      if (now - record.broadcastAt > SETTLE_RECORD_TTL_MS) stale.push(key)
    }
    if (stale.length > 0) {
      await this.ctx.storage.delete(stale)
    }
  }

  /**
   * Broadcast a transferWithAuthorization tx, holding the DO lock just long
   * enough to serialize nonce assignment and the actual `eth_sendRawTransaction`
   * round-trip. Receipt waiting is the caller's responsibility.
   */
  async broadcast(input: DoBroadcastInput): Promise<DoBroadcastResult> {
    return await this.ctx.blockConcurrencyWhile(async () => {
      try {
        // Idempotency gate *inside the lock*: if this (payer, nonce) was
        // already broadcast — by any isolate, any time in the last 72h —
        // return the recorded txHash instead of broadcasting again. This
        // closes the double-broadcast window the in-memory NonceCache leaves
        // open (retry on a different isolate while tx #1 is still in the
        // mempool → second broadcast → revert + a spurious failure response
        // for a payment that actually succeeded).
        const key = settleRecordKey(input.payer, input.nonce)
        const existing = await this.ctx.storage.get<SettleRecord>(key)
        if (existing) {
          console.info(
            JSON.stringify({
              ev: "broadcast.replayed",
              chainId: input.chainId,
              payer: input.payer,
              nonce: input.nonce,
              txHash: existing.txHash,
            }),
          )
          return { ok: true, txHash: existing.txHash, replayed: true }
        }

        // Re-check the authorization's time window *inside the lock*, right
        // before broadcast. The parent Worker already verified the payment,
        // but `blockConcurrencyWhile` can queue this callback behind other
        // settles on the same chain — by the time we run, `validBefore` may
        // have passed. Catching it here avoids paying gas for a tx that the
        // EIP-3009 contract would revert with "authorization is expired".
        const now = BigInt(Math.floor(Date.now() / 1000))
        const timeError = checkTimeWindow(BigInt(input.validAfter), BigInt(input.validBefore), now)
        if (timeError) {
          return { ok: false, reason: timeError }
        }

        const chain = getJpycChain(input.chainId)
        const account = this.getAccount()
        const rpcUrls = readRpcUrls(this.env, input.chainId, chain.publicRpc)
        const wallet = createWalletClient({
          account,
          chain: resolveViemChain(input.chainId),
          transport: fallback(
            rpcUrls.map((u) => http(u, { timeout: 30_000, retryCount: 0 })),
            { rank: false, retryCount: 1 },
          ),
        })

        const { v, r, s } = splitSignatureComponents(input.signature)

        const txHash = await wallet.writeContract({
          address: chain.jpycAddress,
          abi: JPYC_ABI,
          functionName: "transferWithAuthorization",
          args: [
            input.payer,
            input.payTo,
            BigInt(input.valueAtomic),
            BigInt(input.validAfter),
            BigInt(input.validBefore),
            input.nonce,
            v,
            r,
            s,
          ],
          account,
          chain: wallet.chain,
        })

        // Persist the broadcast record BEFORE returning — the write is inside
        // the lock, so a concurrent retry can never observe "no record" after
        // a broadcast happened. Storage failure is deliberately non-fatal:
        // the tx is already out, and failing the response here would make the
        // caller believe the settle failed.
        await this.ctx.storage
          .put(key, {
            txHash,
            broadcastAt: Date.now(),
            chainId: input.chainId,
            payer: input.payer.toLowerCase(),
            nonce: input.nonce.toLowerCase(),
          } satisfies SettleRecord)
          .catch((pe) => {
            console.error(
              JSON.stringify({
                ev: "broadcast.record_put_failed",
                chainId: input.chainId,
                nonce: input.nonce,
                txHash,
                error: pe instanceof Error ? pe.message : String(pe),
              }),
            )
          })

        // Opportunistic prune outside the response path.
        if (Date.now() - this.lastPruneAt > PRUNE_INTERVAL_MS) {
          this.lastPruneAt = Date.now()
          this.ctx.waitUntil(
            this.pruneSettleRecords().catch((pe) =>
              console.error("[RelayerSignerDO] prune failed:", pe),
            ),
          )
        }

        return { ok: true, txHash }
      } catch (e) {
        // Always log the full exception — the wire `errorReason` is a coarse
        // code (and gets truncated at the first colon by the HTTP layer), so
        // this structured line is the only place the real cause survives.
        const err = e as Record<string, unknown> & Error
        console.error(
          JSON.stringify({
            ev: "broadcast.error",
            chainId: input.chainId,
            payer: input.payer,
            nonce: input.nonce,
            name: err?.name,
            message: err?.message,
            shortMessage: (err as { shortMessage?: string })?.shortMessage,
            metaMessages: (err as { metaMessages?: unknown })?.metaMessages,
            cause:
              err?.cause instanceof Error
                ? { name: err.cause.name, message: err.cause.message }
                : err?.cause,
            stack: err?.stack,
          }),
        )
        // The relayer wallet itself being out of gas is not a contract
        // revert — classify it first so it never collapses into the opaque
        // `unexpected_settle_error` bucket. The cron balance monitor warns on
        // a low relayer balance; this is the same condition observed at the
        // moment of broadcast, surfaced with an actionable wire code.
        if (isRelayerGasExhaustionError(e)) {
          return {
            ok: false,
            reason: FACILITATOR_INTERNAL_ERROR_CODES.facilitator_insufficient_native_balance,
          }
        }
        // viem's writeContract simulates before sending, so a revert (e.g.
        // an authorization that expired in the gap between verify and this
        // broadcast) surfaces here. Map known EIP-3009 revert strings to a
        // wire error code; fall back to the raw message otherwise.
        const code = parseEip3009RevertReason(e)
        if (code) return { ok: false, reason: code }
        const msg = err?.message ?? String(e)
        return { ok: false, reason: `${X402_ERROR_CODES.unexpected_settle_error}: ${msg}` }
      }
    })
  }
}

function readRpcUrls(env: WorkerEnv, chainId: number, fallbackUrl: string): string[] {
  const key = `RPC_URLS_${chainId}` as keyof WorkerEnv
  const raw = env[key]
  if (typeof raw === "string" && raw.length > 0) {
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  }
  return [fallbackUrl]
}
