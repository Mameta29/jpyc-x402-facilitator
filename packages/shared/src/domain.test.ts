import { describe, expect, it } from "vitest"
import {
  buildJpycEip712Domain,
  buildReceiveWithAuthorizationTypedData,
  buildTransferWithAuthorizationTypedData,
} from "./domain.js"
import { getJpycChain } from "./chains.js"

const sampleMessage = {
  from: "0x857b06519E91e3A54538791bDbb0E22373e36b66" as const,
  to: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C" as const,
  value: 1_000_000_000_000_000_000n,
  validAfter: 0n,
  validBefore: 9999999999n,
  nonce:
    "0xf3746613c2d920b5fdabc0856f2aeb2d4f88ee6037b8cc5d04a71a4462f13480" as const,
}

describe("EIP-712 domain & typed data", () => {
  it("builds domain anchored to chainId + JPYC address", () => {
    const polygon = buildJpycEip712Domain(137)
    expect(polygon).toEqual({
      name: "JPY Coin",
      version: "1",
      chainId: 137,
      verifyingContract: "0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29",
    })
  })

  it("supports passing a chain row directly", () => {
    const chain = getJpycChain(80002)
    const d = buildJpycEip712Domain(chain)
    expect(d.chainId).toBe(80002)
  })

  it("builds TransferWithAuthorization typed data for x402 settlement (facilitator broadcasts)", () => {
    const td = buildTransferWithAuthorizationTypedData({
      chain: 137,
      message: sampleMessage,
    })
    expect(td.primaryType).toBe("TransferWithAuthorization")
    expect(td.types.TransferWithAuthorization[0]).toEqual({ name: "from", type: "address" })
    expect(td.message.value).toBe(sampleMessage.value)
  })

  it("builds ReceiveWithAuthorization typed data (kept for self-collect compat)", () => {
    const td = buildReceiveWithAuthorizationTypedData({
      chain: 137,
      message: sampleMessage,
    })
    expect(td.primaryType).toBe("ReceiveWithAuthorization")
  })
})
