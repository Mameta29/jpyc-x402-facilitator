/**
 * Settle execution abstraction.
 *
 * The Hono app shouldn't care whether settle runs:
 *   - directly in-process (Node, single-machine: Fly max=1, Render Starter)
 *   - through a Cloudflare Durable Object (Workers, where a storage transaction
 *     allocates a nonce and journals signed bytes before any broadcast)
 *
 * Both paths satisfy this interface. The app calls `settle(...)` and gets back
 * a result; the implementation owns the concurrency story.
 *
 *
 * Why split broadcast and receipt waiting:
 *
 *   `transferWithAuthorization` confirms in 2-3s on Polygon, ~12-30s on
 *   Ethereum mainnet. Under heavy load, holding a serialization lock through
 *   receipt waiting blocks throughput unnecessarily. Worse, on Workers the
 *   `blockConcurrencyWhile` callback has a hard 30-second timeout — the
 *   Durable Object is *reset* if exceeded.
 *
 *   The Workers path reserves nonces durably; RPC pending counts alone are not
 *   sufficient when a send response is lost or concurrent requests overlap.
 *
 *   So the SettleRunner contract is:
 *     1. broadcast() — must allocate nonces atomically per (chainId, signer)
 *     2. waitForReceipt() — fully concurrent
 */

import {
  ExactEvmFacilitator,
  TRANSFER_EVENT_SIGNATURE,
  AUTHORIZATION_USED_EVENT_SIGNATURE,
  splitSignatureComponents,
  type SettleResult,
  type VerifyResult,
} from "@jpyc-x402/evm"
import {
  type PaymentPayload,
  type PaymentRequirements,
  caip2ToEvmChainId,
  getJpycChain,
} from "@jpyc-x402/shared"
import { JPYC_ABI } from "@jpyc-x402/evm"
import {
  type Account,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  formatEther,
} from "viem"

export interface BroadcastInput {
  chainId: number
  payer: Address
  payTo: Address
  valueAtomic: bigint
  validAfter: bigint
  validBefore: bigint
  nonce: Hex
  signature: Hex
}

export interface BroadcastOk {
  ok: true
  txHash: Hex
}
export interface BroadcastFail {
  ok: false
  reason: string
}
export type BroadcastResult = BroadcastOk | BroadcastFail

/**
 * The interface every host has to implement to plug into the Hono app.
 *
 * - InProcessSettleRunner (Node) is the trivial implementation that holds an
 *   in-process mutex per chainId.
 * - DurableObjectSettleRunner (Workers) forwards `broadcast()` to a DO that
 *   uses durable transactions for local nonce allocation and signing, while
 *   `waitForReceipt()` runs back in the parent Worker for parallelism.
 */
export interface SettleRunner {
  /** Run a verify+settle for one PaymentPayload, return the wire-shaped result. */
  settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    options?: { receiptTimeoutMs?: number },
  ): Promise<{ verify: VerifyResult; settle?: SettleResult; timeline?: SettlementTimeline }>
}

/** Server timestamps (milliseconds), not customer-facing payment states. */
export interface SettlementTimeline {
  receivedAt?: number
  verifiedAt?: number
  queueEnteredAt?: number
  broadcastStartedAt?: number
  broadcastAt?: number
  receiptObservedAt?: number
  blockTimestamp?: number
}

// ──────────────────────────────────────────────────────────────────────────
// In-process runner: works for Node (Fly/Render) and is the default.
//
// Concurrency: a per-chain mutex serialises broadcast(); receipt waiting runs
// outside the lock so subsequent settles can broadcast immediately.
// ──────────────────────────────────────────────────────────────────────────

export class InProcessSettleRunner implements SettleRunner {
  private readonly mutexes = new Map<number, Promise<void>>()

  constructor(private readonly facilitator: ExactEvmFacilitator) {}

  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    options?: { receiptTimeoutMs?: number },
  ): Promise<{ verify: VerifyResult; settle?: SettleResult }> {
    // facilitator.settle already does verify → broadcast → wait → verify
    // event, but it broadcasts and waits inside the same call. We need to
    // split that for the receipt-outside-lock optimisation.
    //
    // Easiest path: take the per-chain lock around the full settle. For most
    // workloads this is fine — we trade a small amount of throughput for
    // simpler code. Hosts that need higher throughput can implement their own
    // SettleRunner that splits broadcast/receipt explicitly.
    const chainId = caip2ToEvmChainId(requirements.network)
    return await this.runSerialised(chainId, () => this.facilitator.settle(payload, requirements, options))
  }

  private async runSerialised<T>(chainId: number, fn: () => Promise<T>): Promise<T> {
    const previous = this.mutexes.get(chainId) ?? Promise.resolve()
    let release: () => void = () => {}
    const next = new Promise<void>((resolve) => {
      release = resolve
    })
    this.mutexes.set(
      chainId,
      previous.then(() => next),
    )
    try {
      await previous
      return await fn()
    } finally {
      release()
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Helper exposed to runners that want to split broadcast/receipt explicitly
// (e.g. the Workers Durable Object implementation).
// ──────────────────────────────────────────────────────────────────────────

/** Pure broadcast — call inside whatever serialization primitive the host has. */
export async function broadcastTransferWithAuthorization(
  walletClient: WalletClient,
  account: Account,
  input: BroadcastInput,
): Promise<BroadcastResult> {
  const chain = getJpycChain(input.chainId)
  const { v, r, s } = splitSignatureComponents(input.signature)
  try {
    const txHash = await walletClient.writeContract({
      address: chain.jpycAddress,
      abi: JPYC_ABI,
      functionName: "transferWithAuthorization",
      args: [
        input.payer,
        input.payTo,
        input.valueAtomic,
        input.validAfter,
        input.validBefore,
        input.nonce,
        v,
        r,
        s,
      ],
      account,
      chain: walletClient.chain,
    })
    return { ok: true, txHash }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

/** Pure receipt wait + Transfer event verification — runs outside any lock. */
export async function waitAndVerifyTransfer(
  publicClient: PublicClient,
  chainId: number,
  txHash: Hex,
  expected: { payer: Address; payTo: Address; valueAtomic: bigint; nonce?: Hex },
  opts: { receiptTimeoutMs?: number } = {},
): Promise<SettleResult> {
  const chain = getJpycChain(chainId)
  let receipt
  try {
    receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
      timeout: opts.receiptTimeoutMs ?? 120_000,
    })
  } catch (e) {
    return { ok: false, reason: opts.receiptTimeoutMs ? "receipt_pending" : `receipt wait failed: ${(e as Error).message}`, txHash }
  }

  if (receipt.transactionHash.toLowerCase() !== txHash.toLowerCase()) {
    return { ok: false, reason: "receipt transaction hash mismatch", txHash }
  }
  let blockTimestampSec = 0n
  try {
    const block = await publicClient.getBlock({ blockNumber: receipt.blockNumber })
    if (block.hash?.toLowerCase() !== receipt.blockHash.toLowerCase()) {
      return { ok: false, reason: "receipt_block_mismatch", txHash }
    }
    blockTimestampSec = block.timestamp
  } catch {
    return { ok: false, reason: "receipt_block_unavailable", txHash }
  }
  if (receipt.status !== "success") {
    return { ok: false, reason: "tx reverted on-chain", txHash }
  }

  const matched = receipt.logs.some((log) => {
    if (log.removed) return false
    if (log.address.toLowerCase() !== chain.jpycAddress.toLowerCase()) return false
    if (log.topics[0] !== TRANSFER_EVENT_SIGNATURE) return false
    const from = `0x${log.topics[1]?.slice(-40)}`
    const to = `0x${log.topics[2]?.slice(-40)}`
    if (from.toLowerCase() !== expected.payer.toLowerCase()) return false
    if (to.toLowerCase() !== expected.payTo.toLowerCase()) return false
    try { return BigInt(log.data) === expected.valueAtomic } catch { return false }
  })
  if (!matched) {
    return {
      ok: false,
      reason: "Transfer event in receipt did not match expected (payer, payTo, value)",
      txHash,
    }
  }
  if (expected.nonce && !receipt.logs.some(log =>
    !log.removed &&
    log.address.toLowerCase() === chain.jpycAddress.toLowerCase() &&
    log.topics[0] === AUTHORIZATION_USED_EVENT_SIGNATURE &&
    log.topics[1]?.toLowerCase() === `0x${expected.payer.slice(2).toLowerCase().padStart(64, "0")}` &&
    log.topics[2]?.toLowerCase() === expected.nonce!.toLowerCase())) {
    return { ok: false, reason: "AuthorizationUsed event did not match expected (payer, nonce)", txHash }
  }

  const gasCostWei = receipt.gasUsed * receipt.effectiveGasPrice
  return {
    ok: true,
    txHash,
    blockNumber: receipt.blockNumber,
    blockTimestamp: new Date(Number(blockTimestampSec) * 1000),
    gasUsed: receipt.gasUsed,
    effectiveGasPrice: receipt.effectiveGasPrice,
    gasCostNative: formatEther(gasCostWei),
  }
}
