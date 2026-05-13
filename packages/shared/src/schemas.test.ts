import { describe, expect, it } from "vitest"
import {
  paymentPayloadSchema,
  paymentRequiredSchema,
  paymentRequirementsSchema,
  settlementResponseSchema,
  supportedResponseSchema,
  verifyRequestSchema,
} from "./schemas.js"

const validRequirements = {
  scheme: "exact",
  network: "eip155:80002",
  amount: "1000000000000000000",
  asset: "0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29",
  payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
  maxTimeoutSeconds: 90,
  extra: { assetTransferMethod: "eip3009", name: "JPY Coin", version: "1" },
}

const validPayload = {
  x402Version: 2,
  accepted: validRequirements,
  payload: {
    signature:
      "0x2d6a7588d6acca505cbf0d9a4a227e0c52c6c34008c8e8986a1283259764173608a2ce6496642e377d6da8dbbf5836e9bd15092f9ecab05ded3d6293af148b571c",
    authorization: {
      from: "0x857b06519E91e3A54538791bDbb0E22373e36b66",
      to: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
      value: "1000000000000000000",
      validAfter: "0",
      validBefore: "9999999999",
      nonce: "0xf3746613c2d920b5fdabc0856f2aeb2d4f88ee6037b8cc5d04a71a4462f13480",
    },
  },
}

describe("Zod schemas — happy paths", () => {
  it("accepts a valid PaymentRequirements", () => {
    expect(() => paymentRequirementsSchema.parse(validRequirements)).not.toThrow()
  })

  it("accepts a valid PaymentRequired", () => {
    expect(() =>
      paymentRequiredSchema.parse({
        x402Version: 2,
        resource: { url: "https://shop.example.com/x" },
        accepts: [validRequirements],
      }),
    ).not.toThrow()
  })

  it("accepts a valid PaymentPayload", () => {
    expect(() => paymentPayloadSchema.parse(validPayload)).not.toThrow()
  })

  it("accepts a valid VerifyRequest", () => {
    expect(() =>
      verifyRequestSchema.parse({
        x402Version: 2,
        paymentPayload: validPayload,
        paymentRequirements: validRequirements,
      }),
    ).not.toThrow()
  })

  it("accepts a valid SettlementResponse", () => {
    expect(() =>
      settlementResponseSchema.parse({
        success: true,
        transaction:
          "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
        network: "eip155:80002",
        payer: "0x857b06519E91e3A54538791bDbb0E22373e36b66",
      }),
    ).not.toThrow()
  })

  it("accepts a valid SupportedResponse", () => {
    expect(() =>
      supportedResponseSchema.parse({
        kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:137" }],
        extensions: [],
        signers: { "eip155:*": ["0x209693Bc6afc0C5328bA36FaF03C514EF312287C"] },
      }),
    ).not.toThrow()
  })
})

describe("Zod schemas — rejection paths", () => {
  it("rejects unknown scheme", () => {
    expect(() =>
      paymentRequirementsSchema.parse({ ...validRequirements, scheme: "deferred" }),
    ).toThrow()
  })

  it("rejects non-CAIP-2 network", () => {
    expect(() =>
      paymentRequirementsSchema.parse({ ...validRequirements, network: "polygon" }),
    ).toThrow()
  })

  it("rejects non-decimal amount", () => {
    expect(() =>
      paymentRequirementsSchema.parse({ ...validRequirements, amount: "1.5" }),
    ).toThrow()
  })

  it("rejects malformed address", () => {
    expect(() =>
      paymentRequirementsSchema.parse({ ...validRequirements, payTo: "0xnope" }),
    ).toThrow()
  })

  it("rejects assetTransferMethod other than eip3009 (we don't support permit2 here)", () => {
    expect(() =>
      paymentRequirementsSchema.parse({
        ...validRequirements,
        extra: { assetTransferMethod: "permit2", name: "JPY Coin", version: "1" },
      }),
    ).toThrow()
  })

  it("rejects wrong protocol version", () => {
    expect(() => paymentPayloadSchema.parse({ ...validPayload, x402Version: 1 })).toThrow()
  })

  it("rejects malformed signature length", () => {
    expect(() =>
      paymentPayloadSchema.parse({
        ...validPayload,
        payload: { ...validPayload.payload, signature: "0xdeadbeef" },
      }),
    ).toThrow()
  })

  it("rejects nonce that is not 32 bytes", () => {
    expect(() =>
      paymentPayloadSchema.parse({
        ...validPayload,
        payload: {
          ...validPayload.payload,
          authorization: { ...validPayload.payload.authorization, nonce: "0xdeadbeef" },
        },
      }),
    ).toThrow()
  })
})
