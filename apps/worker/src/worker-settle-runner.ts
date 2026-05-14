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
  type RpcResolver,
} from "@jpyc-x402/evm"
import {
  type SettleRunner,
  waitAndVerifyTransfer,
} from "@jpyc-x402/facilitator"
import {
  caip2ToEvmChainId,
  type PaymentPayload,
  type PaymentRequirements,
} from "@jpyc-x402/shared"
import type { Address, Hex } from "viem"
import type { WorkerEnv } from "./env"
import type { DoBroadcastResult } from "./relayer-signer-do"

export class WorkerSettleRunner implements SettleRunner {
  constructor(
    private readonly env: WorkerEnv,
    private readonly facilitator: ExactEvmFacilitator,
    private readonly rpcResolver: RpcResolver,
  ) {}

  async settle(payload: PaymentPayload, requirements: PaymentRequirements) {
    const verify = await this.facilitator.verify(payload, requirements)
    if (!verify.ok) {
      return { verify }
    }

    const chainId = caip2ToEvmChainId(requirements.network)
    const auth = payload.payload.authorization

    // Route to the per-chain DO. idFromName ensures every settle on chain N
    // hits the same DO instance, so blockConcurrencyWhile is meaningful.
    const id = this.env.RELAYER.idFromName(`chain-${chainId}`)
    const stub = this.env.RELAYER.get(id) as unknown as {
      broadcast: (input: {
        chainId: number
        payer: Address
        payTo: Address
        valueAtomic: string
        validAfter: string
        validBefore: string
        nonce: Hex
        signature: Hex
      }) => Promise<DoBroadcastResult>
    }

    const broadcast = await stub.broadcast({
      chainId,
      payer: auth.from as Address,
      payTo: auth.to as Address,
      valueAtomic: auth.value,
      validAfter: auth.validAfter,
      validBefore: auth.validBefore,
      nonce: auth.nonce as Hex,
      signature: payload.payload.signature as Hex,
    })

    if (!broadcast.ok) {
      return {
        verify,
        settle: { ok: false as const, reason: broadcast.reason },
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
      },
    )

    return { verify, settle }
  }
}
