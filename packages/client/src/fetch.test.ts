import { describe, expect, it, vi } from "vitest"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import {
  createPaymentRequired,
  createPaymentRequirements,
  encodeJsonBase64Url,
  decodeJsonBase64Url,
  type PaymentPayload,
} from "@jpyc-x402/shared"
import { fetchWithPayment } from "./fetch.js"
import { HEADER_PAYMENT_REQUIRED, HEADER_PAYMENT_RESPONSE, HEADER_PAYMENT_SIGNATURE } from "./headers.js"

describe("fetchWithPayment", () => {
  it("returns the first response unchanged when status != 402", async () => {
    const sk = generatePrivateKey()
    const account = privateKeyToAccount(sk)
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }))
    const res = await fetchWithPayment(
      "https://example.com/x",
      undefined,
      { signer: account, fetch: fetchMock as unknown as typeof fetch },
    )
    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("signs the authorization and replays with PAYMENT-SIGNATURE on 402", async () => {
    const sk = generatePrivateKey()
    const account = privateKeyToAccount(sk)
    const requirements = createPaymentRequirements({
      chainId: 80002,
      amountAtomic: "1000000000000000000",
      payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
    })
    const required = createPaymentRequired({
      resource: "https://example.com/x",
      accepts: [requirements],
    })
    const settledHeader = encodeJsonBase64Url({
      success: true,
      transaction: "0xtx",
      network: "eip155:80002",
    })

    let capturedHeader: string | null = null
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      const sig = headers.get(HEADER_PAYMENT_SIGNATURE)
      if (!sig) {
        return new Response("", {
          status: 402,
          headers: { [HEADER_PAYMENT_REQUIRED]: encodeJsonBase64Url(required) },
        })
      }
      capturedHeader = sig
      return new Response("paid content", {
        status: 200,
        headers: { [HEADER_PAYMENT_RESPONSE]: settledHeader },
      })
    })

    const onPaymentRequired = vi.fn()
    const onSettled = vi.fn()
    const res = await fetchWithPayment(
      "https://example.com/x",
      undefined,
      {
        signer: account,
        fetch: fetchMock as unknown as typeof fetch,
        onPaymentRequired,
        onSettled,
      },
    )
    expect(res.status).toBe(200)
    expect(await res.text()).toBe("paid content")
    expect(capturedHeader).toBeTruthy()
    const decoded = decodeJsonBase64Url<PaymentPayload>(capturedHeader!)
    expect(decoded.x402Version).toBe(2)
    expect(decoded.payload.authorization.from.toLowerCase()).toBe(account.address.toLowerCase())
    expect(onPaymentRequired).toHaveBeenCalledTimes(1)
    expect(onSettled).toHaveBeenCalledTimes(1)
  })

  it("uses caller-provided selector to pick a payment option", async () => {
    const sk = generatePrivateKey()
    const account = privateKeyToAccount(sk)
    const a = createPaymentRequirements({
      chainId: 80002,
      amountAtomic: "1",
      payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
    })
    const b = createPaymentRequirements({
      chainId: 137,
      amountAtomic: "1",
      payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
    })
    const required = createPaymentRequired({
      resource: "https://example.com/x",
      accepts: [a, b],
    })
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      const sig = headers.get(HEADER_PAYMENT_SIGNATURE)
      if (!sig) {
        return new Response("", {
          status: 402,
          headers: { [HEADER_PAYMENT_REQUIRED]: encodeJsonBase64Url(required) },
        })
      }
      return new Response("ok", { status: 200 })
    })
    const selectorSpy = vi.fn((accepts) => accepts[1]!)
    await fetchWithPayment(
      "https://example.com/x",
      undefined,
      { signer: account, fetch: fetchMock as unknown as typeof fetch, selector: selectorSpy },
    )
    expect(selectorSpy).toHaveBeenCalledTimes(1)
  })
})
