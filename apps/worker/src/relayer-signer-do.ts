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
import { JPYC_ABI, splitSignatureComponents, resolveViemChain } from "@jpyc-x402/evm"
import { getJpycChain } from "@jpyc-x402/shared"
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
        return { ok: false, reason: e instanceof Error ? e.message : String(e) }
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
