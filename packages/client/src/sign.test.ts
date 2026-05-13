import { describe, expect, it } from "vitest"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import {
  createPaymentRequirements,
  buildJpycEip712Domain,
  TRANSFER_WITH_AUTHORIZATION_TYPES,
  paymentPayloadSchema,
} from "@jpyc-x402/shared"
import { recoverAddress, hashTypedData, type Hex } from "viem"
import { signPaymentPayload } from "./sign.js"

describe("signPaymentPayload", () => {
  it("returns a wire-shaped payload that recovers to the signer address", async () => {
    const sk = generatePrivateKey()
    const account = privateKeyToAccount(sk)
    const requirements = createPaymentRequirements({
      chainId: 80002,
      amountAtomic: 5_000_000_000_000_000_000n,
      payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
    })
    const payload = await signPaymentPayload({
      signer: account,
      requirements,
      validBeforeSeconds: 9_999_999_999n,
    })
    expect(() => paymentPayloadSchema.parse(payload)).not.toThrow()

    const digest = hashTypedData({
      domain: buildJpycEip712Domain(80002),
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: account.address,
        to: requirements.payTo as `0x${string}`,
        value: 5_000_000_000_000_000_000n,
        validAfter: 0n,
        validBefore: 9_999_999_999n,
        nonce: payload.payload.authorization.nonce as Hex,
      },
    })
    const recovered = await recoverAddress({
      hash: digest,
      signature: payload.payload.signature as Hex,
    })
    expect(recovered.toLowerCase()).toBe(account.address.toLowerCase())
  })

  it("uses caller-supplied nonce/validity when provided", async () => {
    const sk = generatePrivateKey()
    const account = privateKeyToAccount(sk)
    const requirements = createPaymentRequirements({
      chainId: 80002,
      amountAtomic: "1",
      payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
    })
    const payload = await signPaymentPayload({
      signer: account,
      requirements,
      nonce: "0x" + "ab".repeat(32) as `0x${string}`,
      validAfterSeconds: 100n,
      validBeforeSeconds: 200n,
    })
    expect(payload.payload.authorization.nonce).toBe("0x" + "ab".repeat(32))
    expect(payload.payload.authorization.validAfter).toBe("100")
    expect(payload.payload.authorization.validBefore).toBe("200")
  })
})
