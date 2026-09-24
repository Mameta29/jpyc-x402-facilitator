/**
 * SettleRunner implementation backed by the RelayerSignerDO.
 *
 * Flow per settle:
 *   1. Verify the payment via @jpyc-x402/evm (read-only RPC; no DO needed)
 *   2. Forward to the chain's RelayerSignerDO to broadcast under the
 *      `blockConcurrencyWhile` lock
 *   3. Wait for the receipt + verify the Transfer event back in the parent
 *      Worker — fully concurrent across requests
 *
 * The DO never holds the lock through receipt waiting (see
 * relayer-signer-do.ts header for the rationale).
 */

import {
  ExactEvmFacilitator,
  buildPublicClient,
  checkRequirementsMatch,
  type VerifyResult,
  type RpcResolver,
} from "@jpyc-x402/evm"
import {
  type SettleRunner,
  waitAndVerifyTransfer,
  type SettlementTimeline,
} from "@jpyc-x402/facilitator"
import {
  caip2ToEvmChainId,
  getJpycChain,
  type PaymentPayload,
  type PaymentRequirements,
} from "@jpyc-x402/shared"
import type { Address, Hex } from "viem"
import type { WorkerEnv } from "./env"
import type { DoBroadcastResult, DoBroadcastInput, SettleRecord } from "./relayer-signer-do"
import { authorizationFingerprint } from "./settlement-record"

export class WorkerSettleRunner implements SettleRunner {
  constructor(
    private readonly env: WorkerEnv,
    private readonly facilitator: ExactEvmFacilitator,
    private readonly rpcResolver: RpcResolver,
  ) {}

  async settle(payload: PaymentPayload, requirements: PaymentRequirements, options?: { receiptTimeoutMs?: number }) {
    const timeline: SettlementTimeline = { receivedAt: Date.now() }
    const chainId = caip2ToEvmChainId(requirements.network)
    const auth = payload.payload.authorization

    // Route to the per-chain DO. idFromName ensures every settle on chain N
    // hits the same DO instance, so blockConcurrencyWhile is meaningful.
    const id = this.env.RELAYER.idFromName(`chain-${chainId}`)
    const stub = this.env.RELAYER.get(id) as unknown as {
      broadcast: (input: DoBroadcastInput) => Promise<DoBroadcastResult>
      getSettleRecord: (payer: string, nonce: string) => Promise<SettleRecord | null>
      recordReceipt: (payer: string, nonce: string, txHash: string, observation: { receiptObservedAt: number; blockTimestamp?: number }) => Promise<void>
    }
    const input: DoBroadcastInput = {
      chainId,
      payer: auth.from as Address,
      payTo: auth.to as Address,
      valueAtomic: auth.value,
      validAfter: auth.validAfter,
      validBefore: auth.validBefore,
      nonce: auth.nonce as Hex,
      signature: payload.payload.signature as Hex,
    }
    let verify: VerifyResult = await this.facilitator.verify(payload, requirements)
    let broadcast: DoBroadcastResult
    if (!verify.ok) {
      // A retry can arrive AFTER mining or expiry. Do not rebroadcast and do
      // not turn a successful payment into a nonce-used / expired failure.
      // Only an identical, previously verified authorization may take this path.
      const record = await stub.getSettleRecord(auth.from, auth.nonce)
      if (!record?.authorizationHash || record.authorizationHash !== authorizationFingerprint(input) ||
          !checkRequirementsMatch(payload, requirements).ok ||
          requirements.asset.toLowerCase() !== getJpycChain(chainId).jpycAddress.toLowerCase() ||
          requirements.payTo.toLowerCase() !== auth.to.toLowerCase() || requirements.amount !== auth.value) {
        return { verify, timeline }
      }
      verify = { ok: true, payer: input.payer, chainId, asset: requirements.asset as Address,
        payTo: input.payTo, valueAtomic: BigInt(auth.value), validAfter: BigInt(auth.validAfter),
        validBefore: BigInt(auth.validBefore), nonce: input.nonce }
      broadcast = { ok: true, txHash: record.txHash, replayed: true, timeline: record.timeline }
    } else {
      timeline.verifiedAt = Date.now()
      timeline.queueEnteredAt = Date.now()
      broadcast = await stub.broadcast({ ...input, timeline })
    }

    if (!broadcast.ok) {
      return {
        verify,
        settle: { ok: false as const, reason: broadcast.reason },
        timeline,
      }
    }

    // Receipt + Transfer event verification runs *outside* the DO lock so
    // other settles on the same chain can broadcast in parallel.
    const publicClient = buildPublicClient(chainId, this.rpcResolver)
    const settle = await waitAndVerifyTransfer(
      publicClient,
      chainId,
      broadcast.txHash,
      {
        payer: auth.from as Address,
        payTo: auth.to as Address,
        valueAtomic: BigInt(auth.value),
        nonce: auth.nonce as Hex,
      },
      options,
    )
    const observed: SettlementTimeline = { ...timeline, ...broadcast.timeline }
    if (settle.ok) {
      const receiptObservedAt = Date.now()
      const blockTimestamp = settle.blockTimestamp.getTime() || undefined
      Object.assign(observed, { receiptObservedAt, blockTimestamp })
      await stub.recordReceipt(auth.from, auth.nonce, settle.txHash, { receiptObservedAt, blockTimestamp }).catch(() => {
        console.error(JSON.stringify({ ev: "settle.receipt_record_failed", chainId, txHash: settle.txHash }))
      })
    }
    return { verify, settle, timeline: observed }
  }
}
