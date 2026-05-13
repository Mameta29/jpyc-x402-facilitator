import { describe, expect, it } from "vitest"
import { createPaymentRequired, createPaymentRequirements } from "./builders.js"

describe("PaymentRequirements builder", () => {
  it("emits a valid x402 v2 PaymentRequirements for JPYC on Polygon", () => {
    const req = createPaymentRequirements({
      chainId: 137,
      amountAtomic: "1000000000000000000",
      payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
    })
    expect(req).toEqual({
      scheme: "exact",
      network: "eip155:137",
      amount: "1000000000000000000",
      asset: "0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29",
      payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
      maxTimeoutSeconds: 90,
      extra: {
        assetTransferMethod: "eip3009",
        name: "JPY Coin",
        version: "1",
        decimals: 18,
        symbol: "JPYC",
      },
    })
  })

  it("accepts bigint amount and stringifies it", () => {
    const req = createPaymentRequirements({
      chainId: 80002,
      amountAtomic: 5n * 10n ** 18n,
      payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
    })
    expect(req.amount).toBe("5000000000000000000")
    expect(req.network).toBe("eip155:80002")
  })

  it("allows overriding maxTimeoutSeconds, asset, and domain", () => {
    const req = createPaymentRequirements({
      chainId: 137,
      amountAtomic: "1",
      payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
      maxTimeoutSeconds: 30,
      asset: "0x0000000000000000000000000000000000000123",
      domainName: "Wrapped JPYC",
      domainVersion: "2",
    })
    expect(req.maxTimeoutSeconds).toBe(30)
    expect(req.asset).toBe("0x0000000000000000000000000000000000000123")
    expect(req.extra.name).toBe("Wrapped JPYC")
    expect(req.extra.version).toBe("2")
  })

  it("throws for unsupported chainId", () => {
    expect(() =>
      createPaymentRequirements({
        chainId: 99999,
        amountAtomic: "1",
        payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
      }),
    ).toThrow()
  })
})

describe("PaymentRequired builder", () => {
  it("wraps requirements with version, resource, error", () => {
    const reqs = createPaymentRequirements({
      chainId: 137,
      amountAtomic: "1",
      payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
    })
    const required = createPaymentRequired({
      resource: "https://shop.example.com/products/abc/checkout",
      accepts: [reqs],
      error: "PAYMENT-SIGNATURE header is required",
    })
    expect(required.x402Version).toBe(2)
    expect(required.resource.url).toBe("https://shop.example.com/products/abc/checkout")
    expect(required.error).toBe("PAYMENT-SIGNATURE header is required")
    expect(required.accepts.length).toBe(1)
  })

  it("accepts a structured ResourceInfo", () => {
    const reqs = createPaymentRequirements({
      chainId: 137,
      amountAtomic: "1",
      payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
    })
    const required = createPaymentRequired({
      resource: {
        url: "https://shop.example.com/products/abc/checkout",
        description: "1 product",
        mimeType: "application/json",
      },
      accepts: [reqs],
    })
    expect(required.resource.description).toBe("1 product")
  })
})
