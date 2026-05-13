/**
 * Tool-level tests for the generic facilitator MCP. We don't spin up the
 * stdio transport; we exercise each tool's `handler` directly with a fake
 * facilitator HTTP endpoint via fetch mocking.
 */

import { describe, expect, it, vi } from "vitest"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { createPaymentRequirements } from "@jpyc-x402/shared"
import { tools, type ToolDeps } from "./tools.js"

function fakeDeps(): ToolDeps {
  const sk = generatePrivateKey()
  return { resolveSigner: () => privateKeyToAccount(sk) }
}

describe("MCP tools", () => {
  it("create_jpyc_payment signs a payload that carries the right amount/payTo", async () => {
    const requirements = createPaymentRequirements({
      chainId: 80002,
      amountAtomic: "1000",
      payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
    })
    const result = await tools.create_jpyc_payment.handler({ paymentRequirements: requirements }, fakeDeps())
    expect(result.x402Version).toBe(2)
    expect(result.payload.authorization.value).toBe("1000")
    expect(result.payload.authorization.to).toBe(requirements.payTo)
  })

  it("create_and_settle_jpyc_payment short-circuits when verify fails", async () => {
    const requirements = createPaymentRequirements({
      chainId: 80002,
      amountAtomic: "1",
      payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
    })

    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/verify")) {
        return new Response(
          JSON.stringify({ isValid: false, invalidReason: "insufficient_funds" }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }
      throw new Error("settle should not be called")
    })

    // Use a fake fetch via globalThis monkey-patch (FacilitatorClient defaults to global fetch).
    const originalFetch = globalThis.fetch
    globalThis.fetch = fetchMock as unknown as typeof fetch
    try {
      const out = await tools.create_and_settle_jpyc_payment.handler(
        { url: "https://facilitator.test", paymentRequirements: requirements },
        fakeDeps(),
      )
      expect(out.verification).toEqual({
        isValid: false,
        invalidReason: "insufficient_funds",
      })
      expect(out.settlement).toBeNull()
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("create_and_settle_jpyc_payment proceeds to settle on verify ok", async () => {
    const requirements = createPaymentRequirements({
      chainId: 80002,
      amountAtomic: "1",
      payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
    })
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/verify")) {
        return new Response(
          JSON.stringify({
            isValid: true,
            payer: "0x0000000000000000000000000000000000000000",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }
      if (url.endsWith("/settle")) {
        return new Response(
          JSON.stringify({
            success: true,
            transaction: "0xtx",
            network: "eip155:80002",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }
      throw new Error("unexpected url: " + url)
    })
    const originalFetch = globalThis.fetch
    globalThis.fetch = fetchMock as unknown as typeof fetch
    try {
      const out = await tools.create_and_settle_jpyc_payment.handler(
        { url: "https://facilitator.test", paymentRequirements: requirements },
        fakeDeps(),
      )
      expect((out.settlement as { success: boolean }).success).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
