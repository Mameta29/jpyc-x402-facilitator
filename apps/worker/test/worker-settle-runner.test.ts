import { beforeEach, describe, expect, it, vi } from "vitest"
import { ExactEvmFacilitator } from "@jpyc-x402/evm"
import { createPaymentRequirements, type PaymentPayload } from "@jpyc-x402/shared"
import type { WorkerEnv } from "../src/env"
import type { DoBroadcastInput, SettleRecord } from "../src/relayer-signer-do"
import { authorizationFingerprint } from "../src/settlement-record"
import { WorkerSettleRunner } from "../src/worker-settle-runner"

const { receipt } = vi.hoisted(() => ({ receipt: vi.fn() }))
vi.mock("@jpyc-x402/facilitator", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@jpyc-x402/facilitator")>()),
  waitAndVerifyTransfer: receipt,
}))

const input: DoBroadcastInput = {
  chainId: 137,
  payer: `0x${"a".repeat(40)}`,
  payTo: `0x${"b".repeat(40)}`,
  valueAtomic: "0",
  validAfter: "0",
  validBefore: "1000",
  nonce: `0x${"c".repeat(64)}`,
  signature: `0x${"d".repeat(128)}1b`,
}
const txHash = `0x${"e".repeat(64)}` as const
const requirements = createPaymentRequirements({
  chainId: 137,
  amountAtomic: 0n,
  payTo: input.payTo,
  maxTimeoutSeconds: 180,
})
const payload: PaymentPayload = {
  x402Version: 2,
  accepted: requirements,
  payload: {
    signature: input.signature,
    authorization: {
      from: input.payer,
      to: input.payTo,
      value: input.valueAtomic,
      validAfter: input.validAfter,
      validBefore: input.validBefore,
      nonce: input.nonce,
    },
  },
}

function setup(recordOverrides: Partial<SettleRecord> = {}) {
  const record: SettleRecord = {
    chainId: 137,
    payer: input.payer,
    nonce: input.nonce,
    txHash,
    broadcastAt: 200,
    authorizationHash: authorizationFingerprint(input),
    timeline: { broadcastAt: 200 },
    ...recordOverrides,
  }
  const stub = {
    getSettleRecord: vi.fn().mockResolvedValue(record),
    broadcast: vi.fn(),
    recordReceipt: vi.fn().mockResolvedValue(undefined),
    rejectBeforeBroadcast: vi.fn(),
  }
  const verify = vi.fn().mockResolvedValue({ ok: false, reason: "authorization_already_used" })
  const runner = new WorkerSettleRunner(
    { RELAYER: { idFromName: vi.fn(), get: () => stub } } as unknown as WorkerEnv,
    { verify } as unknown as ExactEvmFacilitator,
    () => ({ urls: ["https://rpc.invalid"] }),
  )
  return { runner, stub, verify }
}

describe("WorkerSettleRunner recovery", () => {
  beforeEach(() => {
    receipt.mockReset()
    receipt.mockResolvedValue({ ok: true, txHash, blockTimestamp: new Date(250), chainId: 137 })
  })
  it("fences a locally verified authorization when the RPC verification fails before admission", async () => {
    const { runner, stub, verify } = setup()
    stub.getSettleRecord.mockResolvedValue(null)
    verify.mockResolvedValue({ ok: false, reason: "unexpected_verify_error: simulation unavailable", signatureVerified: true, payer: input.payer })
    const proof = { version: 1, state: "not_submitted", chainId: input.chainId, payer: input.payer,
      nonce: input.nonce, closedAt: Date.now(), authorizationHash: authorizationFingerprint(input) }
    stub.rejectBeforeBroadcast.mockResolvedValue({ ok: false, reason: "verification_unavailable", submissionRejection: proof })
    expect(await runner.settle(payload, requirements)).toMatchObject({ submissionRejection: proof })
    expect(stub.rejectBeforeBroadcast).toHaveBeenCalledWith(input, "verification_unavailable")
    expect(stub.broadcast).not.toHaveBeenCalled()
  })
  it("does not close admission for an unverified signature or an already-used nonce", async () => {
    const { runner, stub, verify } = setup()
    stub.getSettleRecord.mockResolvedValue(null)
    for (const failure of [
      { ok: false, reason: "unexpected_verify_error" },
      { ok: false, reason: "authorization_already_used", signatureVerified: true },
    ]) {
      verify.mockResolvedValue(failure)
      expect(await runner.settle(payload, requirements)).not.toHaveProperty("submissionRejection")
    }
    expect(stub.rejectBeforeBroadcast).not.toHaveBeenCalled()
  })

  it.each(["authorization_already_used", "invalid_exact_evm_payload_authorization_valid_before"])(
    "returns the receipt for an identical signed payment after %s without rebroadcasting",
    async (reason) => {
      const { runner, stub, verify } = setup()
      verify.mockResolvedValue({ ok: false, reason })
      const result = await runner.settle(payload, requirements, { receiptTimeoutMs: 1000 })
      expect(result.settle).toMatchObject({ ok: true, txHash })
      expect(stub.broadcast).not.toHaveBeenCalled()
      expect(receipt).toHaveBeenCalledWith(
        expect.anything(),
        137,
        txHash,
        { payer: input.payer, payTo: input.payTo, valueAtomic: 0n, nonce: input.nonce },
        { receiptTimeoutMs: 1000 },
      )
      expect(stub.recordReceipt).toHaveBeenCalledWith(
        input.payer,
        input.nonce,
        txHash,
        expect.objectContaining({ receiptObservedAt: expect.any(Number), blockTimestamp: 250 }),
      )
      expect(result.timeline).toMatchObject({ broadcastAt: 200 })
    },
  )

  it("keeps a recorded broadcast pending if the receipt is not available", async () => {
    receipt.mockResolvedValue({ ok: false, reason: "receipt_pending", txHash })
    const { runner, stub } = setup()
    expect((await runner.settle(payload, requirements)).settle).toMatchObject({
      ok: false,
      reason: "receipt_pending",
      txHash,
    })
    expect(stub.recordReceipt).not.toHaveBeenCalled()
    expect(stub.broadcast).not.toHaveBeenCalled()
  })

  it.each([undefined, `0x${"f".repeat(64)}`])(
    "does not trust a missing or mismatched fingerprint: %s",
    async (authorizationHash) => {
      const { runner, stub } = setup({ authorizationHash })
      expect((await runner.settle(payload, requirements)).verify.ok).toBe(false)
      expect(receipt).not.toHaveBeenCalled()
      expect(stub.broadcast).not.toHaveBeenCalled()
    },
  )

  it("does not replay a stored signature against changed payment requirements", async () => {
    const { runner, stub } = setup()
    expect((await runner.settle(payload, { ...requirements, amount: "1" })).verify.ok).toBe(false)
    expect(receipt).not.toHaveBeenCalled()
    expect(stub.broadcast).not.toHaveBeenCalled()
  })
})
