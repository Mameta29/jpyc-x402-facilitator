/**
 * Hono app behaviour tests with stubbed facilitator + in-memory rate limiter.
 *
 * No Postgres, no RPC. We exercise:
 *   - GET /health
 *   - GET /supported
 *   - POST /verify happy path + invalid path
 *   - POST /settle happy path, idempotent retry, low-balance refusal
 *   - rate limiting
 */

import { describe, expect, it, vi } from "vitest"
import {
  X402_VERSION,
  createPaymentRequirements,
  type PaymentPayload,
  type PaymentRequirements,
} from "@jpyc-x402/shared"
import type { Address, Hex } from "viem"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import {
  TRANSFER_WITH_AUTHORIZATION_TYPES,
  buildJpycEip712Domain,
} from "@jpyc-x402/shared"
import { createApp } from "./app.js"

const NONCE = "0xf3746613c2d920b5fdabc0856f2aeb2d4f88ee6037b8cc5d04a71a4462f13480" as const
const VALUE = 1_000_000_000_000_000_000n

async function buildPayload(privateKey: Hex, nonce = NONCE) {
  const account = privateKeyToAccount(privateKey)
  const required = createPaymentRequirements({
    chainId: 80002,
    amountAtomic: VALUE,
    payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
  })
  const message = {
    from: account.address,
    to: required.payTo as Address,
    value: VALUE,
    validAfter: 0n,
    validBefore: 9_999_999_999n,
    nonce,
  }
  const signature = (await account.signTypedData({
    domain: buildJpycEip712Domain(80002),
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message,
  })) as Hex
  const payload: PaymentPayload = {
    x402Version: 2,
    accepted: required,
    payload: {
      signature,
      authorization: {
        from: account.address,
        to: required.payTo,
        value: VALUE.toString(),
        validAfter: "0",
        validBefore: "9999999999",
        nonce,
      },
    },
  }
  return { payload, required, payerAddress: account.address }
}

interface FakeRow {
  id: string
  chainId: number
  payer: string
  nonce: string
  status: "verified" | "settled" | "failed"
  txHash: string | null
  valueAtomic: bigint
}

function makeFakeDb() {
  const rows: FakeRow[] = []
  return {
    rows,
    insert() {
      // Drizzle's chained API would be a maintenance burden to mock fully.
      // Tests using POST /settle stub the entire `db` interface below.
    },
  }
}

interface FakeFacilitator {
  supported: ReturnType<typeof vi.fn>
  signers: ReturnType<typeof vi.fn>
  verify: ReturnType<typeof vi.fn>
  settle: ReturnType<typeof vi.fn>
  isChainEnabled: ReturnType<typeof vi.fn>
}

function fakeFacilitator(): FakeFacilitator {
  return {
    supported: vi.fn(() => [
      { x402Version: X402_VERSION, scheme: "exact", network: "eip155:80002" },
    ]),
    signers: vi.fn(() => ({ "eip155:*": ["0x1234567890abcdef1234567890abcdef12345678"] })),
    verify: vi.fn(),
    settle: vi.fn(),
    isChainEnabled: vi.fn(() => true),
  }
}

function fakeRateLimiter() {
  return { consume: vi.fn(async () => {}) }
}

function fakeDb() {
  // Minimal Drizzle surface used by app.ts
  const rows: FakeRow[] = []
  const select = () => ({
    from: () => ({
      where: () => ({
        limit: () => Promise.resolve(rows.slice(0, 1)),
      }),
    }),
  })
  const insert = () => ({
    values: () => ({
      returning: () =>
        Promise.resolve([
          {
            id: "row-1",
            chainId: 80002,
            payer: "0x0",
            nonce: NONCE,
            status: "verified",
            txHash: null,
            valueAtomic: VALUE,
          } as FakeRow,
        ]),
    }),
  })
  const update = () => ({
    set: () => ({
      where: () => Promise.resolve(),
    }),
  })
  return { rows, select, insert, update }
}

describe("Hono app — meta routes", () => {
  it("GET /health returns ok", async () => {
    const app = createApp({
      facilitator: fakeFacilitator() as unknown as Parameters<typeof createApp>[0]["facilitator"],
      db: fakeDb() as unknown as Parameters<typeof createApp>[0]["db"],
      rateLimiter: fakeRateLimiter() as unknown as Parameters<typeof createApp>[0]["rateLimiter"],
      cors: { origins: ["*"] },
      nodeEnv: "test",
    })
    const res = await app.request("/health")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it("GET /supported returns advertised kinds and signers", async () => {
    const app = createApp({
      facilitator: fakeFacilitator() as unknown as Parameters<typeof createApp>[0]["facilitator"],
      db: fakeDb() as unknown as Parameters<typeof createApp>[0]["db"],
      rateLimiter: fakeRateLimiter() as unknown as Parameters<typeof createApp>[0]["rateLimiter"],
      cors: { origins: ["*"] },
      nodeEnv: "test",
    })
    const res = await app.request("/supported")
    const body = await res.json()
    expect(body.kinds[0].network).toBe("eip155:80002")
    expect(body.signers["eip155:*"][0]).toMatch(/^0x[0-9a-f]{40}$/i)
  })
})

describe("Hono app — POST /verify", () => {
  it("returns isValid=true on facilitator success", async () => {
    const sk = generatePrivateKey()
    const { payload, required, payerAddress } = await buildPayload(sk)
    const fac = fakeFacilitator()
    fac.verify.mockResolvedValue({ ok: true, payer: payerAddress, chainId: 80002 })
    const app = createApp({
      facilitator: fac as unknown as Parameters<typeof createApp>[0]["facilitator"],
      db: fakeDb() as unknown as Parameters<typeof createApp>[0]["db"],
      rateLimiter: fakeRateLimiter() as unknown as Parameters<typeof createApp>[0]["rateLimiter"],
      cors: { origins: ["*"] },
      nodeEnv: "test",
    })
    const res = await app.request("/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        x402Version: 2,
        paymentPayload: payload,
        paymentRequirements: required,
      }),
    })
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.isValid).toBe(true)
    expect(body.payer.toLowerCase()).toBe(payerAddress.toLowerCase())
  })

  it("surfaces invalidReason when facilitator rejects", async () => {
    const sk = generatePrivateKey()
    const { payload, required } = await buildPayload(sk)
    const fac = fakeFacilitator()
    fac.verify.mockResolvedValue({ ok: false, reason: "insufficient_funds" })
    const app = createApp({
      facilitator: fac as unknown as Parameters<typeof createApp>[0]["facilitator"],
      db: fakeDb() as unknown as Parameters<typeof createApp>[0]["db"],
      rateLimiter: fakeRateLimiter() as unknown as Parameters<typeof createApp>[0]["rateLimiter"],
      cors: { origins: ["*"] },
      nodeEnv: "test",
    })
    const res = await app.request("/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        x402Version: 2,
        paymentPayload: payload,
        paymentRequirements: required,
      }),
    })
    const body = await res.json()
    expect(body.isValid).toBe(false)
    expect(body.invalidReason).toBe("insufficient_funds")
  })

  it("rejects malformed bodies with invalidReason", async () => {
    const fac = fakeFacilitator()
    const app = createApp({
      facilitator: fac as unknown as Parameters<typeof createApp>[0]["facilitator"],
      db: fakeDb() as unknown as Parameters<typeof createApp>[0]["db"],
      rateLimiter: fakeRateLimiter() as unknown as Parameters<typeof createApp>[0]["rateLimiter"],
      cors: { origins: ["*"] },
      nodeEnv: "test",
    })
    const res = await app.request("/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ x402Version: 2 }),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.isValid).toBe(false)
  })
})

describe("Hono app — POST /settle", () => {
  it("returns success + tx hash on facilitator settle", async () => {
    const sk = generatePrivateKey()
    const { payload, required, payerAddress } = await buildPayload(sk)
    const fac = fakeFacilitator()
    fac.settle.mockResolvedValue({
      verify: { ok: true, payer: payerAddress, chainId: 80002, valueAtomic: VALUE },
      settle: {
        ok: true,
        txHash: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        blockNumber: 1n,
        blockTimestamp: new Date(),
        gasUsed: 100_000n,
        effectiveGasPrice: 1_000_000_000n,
        gasCostNative: "0.0001",
      },
    })
    const app = createApp({
      facilitator: fac as unknown as Parameters<typeof createApp>[0]["facilitator"],
      db: fakeDb() as unknown as Parameters<typeof createApp>[0]["db"],
      rateLimiter: fakeRateLimiter() as unknown as Parameters<typeof createApp>[0]["rateLimiter"],
      cors: { origins: ["*"] },
      nodeEnv: "test",
    })
    const res = await app.request("/settle", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        x402Version: 2,
        paymentPayload: payload,
        paymentRequirements: required,
      }),
    })
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.transaction).toMatch(/^0x[0-9a-f]+$/i)
    expect(body.network).toBe(required.network)
  })

  it("returns success on idempotent replay (already-settled row)", async () => {
    const sk = generatePrivateKey()
    const { payload, required, payerAddress } = await buildPayload(sk)
    const fac = fakeFacilitator()
    const db = fakeDb()
    db.rows.push({
      id: "row-1",
      chainId: 80002,
      payer: payerAddress.toLowerCase(),
      nonce: NONCE,
      status: "settled",
      txHash: "0xCAFE0000CAFE0000CAFE0000CAFE0000CAFE0000CAFE0000CAFE0000CAFE0000",
      valueAtomic: VALUE,
    })
    const app = createApp({
      facilitator: fac as unknown as Parameters<typeof createApp>[0]["facilitator"],
      db: db as unknown as Parameters<typeof createApp>[0]["db"],
      rateLimiter: fakeRateLimiter() as unknown as Parameters<typeof createApp>[0]["rateLimiter"],
      cors: { origins: ["*"] },
      nodeEnv: "test",
    })
    const res = await app.request("/settle", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        x402Version: 2,
        paymentPayload: payload,
        paymentRequirements: required,
      }),
    })
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.transaction.toLowerCase()).toBe(
      "0xcafe0000cafe0000cafe0000cafe0000cafe0000cafe0000cafe0000cafe0000",
    )
    expect(fac.settle).not.toHaveBeenCalled()
  })

  it("propagates rate-limit errors as 429", async () => {
    const sk = generatePrivateKey()
    const { payload, required } = await buildPayload(sk)
    const fac = fakeFacilitator()
    const limiter = {
      consume: vi.fn(async () => {
        const { X402Error, FACILITATOR_INTERNAL_ERROR_CODES } = await import("@jpyc-x402/shared")
        throw new X402Error(FACILITATOR_INTERNAL_ERROR_CODES.facilitator_rate_limited, {
          message: "too many",
        })
      }),
    }
    const app = createApp({
      facilitator: fac as unknown as Parameters<typeof createApp>[0]["facilitator"],
      db: fakeDb() as unknown as Parameters<typeof createApp>[0]["db"],
      rateLimiter: limiter as unknown as Parameters<typeof createApp>[0]["rateLimiter"],
      cors: { origins: ["*"] },
      nodeEnv: "test",
    })
    const res = await app.request("/settle", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        x402Version: 2,
        paymentPayload: payload,
        paymentRequirements: required,
      }),
    })
    expect(res.status).toBe(429)
    const body = await res.json()
    expect(body.errorReason).toBe("facilitator_rate_limited")
  })

  it("refuses settle when relayer balance is critical", async () => {
    const sk = generatePrivateKey()
    const { payload, required } = await buildPayload(sk)
    const fac = fakeFacilitator()
    const monitor = { isCritical: vi.fn(async () => true) }
    const app = createApp({
      facilitator: fac as unknown as Parameters<typeof createApp>[0]["facilitator"],
      db: fakeDb() as unknown as Parameters<typeof createApp>[0]["db"],
      rateLimiter: fakeRateLimiter() as unknown as Parameters<typeof createApp>[0]["rateLimiter"],
      balanceMonitor: monitor as unknown as Parameters<typeof createApp>[0]["balanceMonitor"],
      cors: { origins: ["*"] },
      nodeEnv: "test",
    })
    const res = await app.request("/settle", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        x402Version: 2,
        paymentPayload: payload,
        paymentRequirements: required,
      }),
    })
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.errorReason).toBe("facilitator_insufficient_native_balance")
  })
})
