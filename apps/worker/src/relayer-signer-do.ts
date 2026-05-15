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
  parseEip3009RevertReason,
  splitSignatureComponents,
  resolveViemChain,
} from "@jpyc-x402/evm"
import { X402_ERROR_CODES, getJpycChain } from "@jpyc-x402/shared"
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
}
export interface DoBroadcastFail {
  ok: false
  reason: string
}
export type DoBroadcastResult = DoBroadcastOk | DoBroadcastFail

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

  /**
   * Broadcast a transferWithAuthorization tx, holding the DO lock just long
   * enough to serialize nonce assignment and the actual `eth_sendRawTransaction`
   * round-trip. Receipt waiting is the caller's responsibility.
   */
  async broadcast(input: DoBroadcastInput): Promise<DoBroadcastResult> {
    return await this.ctx.blockConcurrencyWhile(async () => {
      try {
        // Re-check the authorization's time window *inside the lock*, right
        // before broadcast. The parent Worker already verified the payment,
        // but `blockConcurrencyWhile` can queue this callback behind other
        // settles on the same chain — by the time we run, `validBefore` may
        // have passed. Catching it here avoids paying gas for a tx that the
        // EIP-3009 contract would revert with "authorization is expired".
        const now = BigInt(Math.floor(Date.now() / 1000))
        const timeError = checkTimeWindow(
          BigInt(input.validAfter),
          BigInt(input.validBefore),
          now,
        )
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
