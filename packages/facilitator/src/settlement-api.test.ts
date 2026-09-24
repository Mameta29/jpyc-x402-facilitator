import { describe, expect, it, vi } from "vitest"
import type { ExactEvmFacilitator } from "@jpyc-x402/evm"
import { createPaymentRequirements } from "@jpyc-x402/shared"
import { createApp } from "./app"
import { NonceCache } from "./nonce-cache"
import { RateLimiter } from "./rate-limit"

const payer = `0x${"a".repeat(40)}` as const
const payTo = `0x${"b".repeat(40)}` as const
const nonce = `0x${"c".repeat(64)}` as const
const txHash = `0x${"d".repeat(64)}` as const
const requirements = createPaymentRequirements({ chainId: 137, amountAtomic: 0n, payTo })
const body = {
  x402Version: 2,
  paymentRequirements: requirements,
  paymentPayload: {
    x402Version: 2,
    accepted: requirements,
    payload: {
      signature: `0x${"e".repeat(128)}1b`,
      authorization: {
        from: payer,
        to: payTo,
        value: "0",
        nonce,
        validAfter: "0",
        validBefore: "9999999999",
      },
    },
  },
}

function setup() {
  const settle = vi.fn().mockResolvedValue({
    verify: {
      ok: true,
      payer,
      chainId: 137,
      asset: requirements.asset,
      payTo,
      valueAtomic: 0n,
      validAfter: 0n,
      validBefore: 9999999999n,
      nonce,
    },
    settle: { ok: false, reason: "receipt_pending", txHash },
    timeline: { receivedAt: 1000, broadcastAt: 1100 },
  })
  const get = vi
    .fn()
    .mockResolvedValue({
      txHash,
      broadcastAt: 1100,
      timeline: { broadcastAt: 1100, receiptObservedAt: 1200 },
    })
  const nonceCache = new NonceCache()
  const app = createApp({
    facilitator: {} as ExactEvmFacilitator,
    settleRunner: { settle },
    settleRecords: { get },
    nonceCache,
    rateLimiter: new RateLimiter({ windowSeconds: 60, maxRequests: 10 }),
    cors: { origins: ["*"] },
    nodeEnv: "test",
  })
  const post = (path: string, payload: unknown) =>
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    })
  return { post, settle, get, nonceCache }
}

describe("settlement API compatibility", () => {
  it.each([undefined, 8000])(
    "forwards an optional receipt budget %s and preserves pending evidence",
    async (receiptTimeoutMs) => {
      const { post, settle } = setup()
      const response = await post("/settle", { ...body, receiptTimeoutMs })
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        success: false,
        errorReason: "receipt_pending",
        transaction: txHash,
        extensions: { "jpyc.settlementTimeline": { receivedAt: 1000, broadcastAt: 1100 } },
      })
      expect(settle).toHaveBeenCalledWith(
        body.paymentPayload,
        body.paymentRequirements,
        receiptTimeoutMs === undefined ? undefined : { receiptTimeoutMs },
      )
    },
  )

  it("uses durable observations before a process cache hit without broadcasting", async () => {
    const { post, settle, nonceCache } = setup()
    nonceCache.remember(137, payer, nonce, { settled: true, txHash })
    expect(
      await (await post("/settle-status", { network: "eip155:137", payer, nonce })).json(),
    ).toEqual({
      known: true,
      txHash,
      broadcastAt: 1100,
      timeline: { broadcastAt: 1100, receiptObservedAt: 1200 },
      source: "durable",
    })
    expect(settle).not.toHaveBeenCalled()
  })

  it("does not turn an absent record into a failed payment", async () => {
    const { post, get, settle } = setup()
    get.mockResolvedValue(null)
    expect(
      await (await post("/settle-status", { network: "eip155:137", payer, nonce })).json(),
    ).toEqual({ known: false })
    expect(settle).not.toHaveBeenCalled()
  })
})
