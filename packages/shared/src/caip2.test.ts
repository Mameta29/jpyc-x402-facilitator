import { describe, expect, it } from "vitest"
import {
  caip2ToEvmChainId,
  evmChainIdToCaip2,
  formatCaip2,
  isCaip2,
  parseCaip2,
} from "./caip2.js"

describe("CAIP-2 helpers", () => {
  it("parses standard EVM forms", () => {
    expect(parseCaip2("eip155:137")).toEqual({ namespace: "eip155", reference: "137" })
    expect(parseCaip2("eip155:1")).toEqual({ namespace: "eip155", reference: "1" })
    expect(parseCaip2("eip155:11155111")).toEqual({
      namespace: "eip155",
      reference: "11155111",
    })
  })

  it("parses non-EVM forms", () => {
    expect(parseCaip2("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp")).toEqual({
      namespace: "solana",
      reference: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    })
  })

  it("rejects malformed input", () => {
    expect(() => parseCaip2("eip155")).toThrow()
    expect(() => parseCaip2("137")).toThrow()
    expect(() => parseCaip2("EIP155:137")).toThrow() // namespace must be lowercase
    expect(() => parseCaip2("ei:1")).toThrow() // namespace too short
    expect(isCaip2("not-a-caip2")).toBe(false)
    expect(isCaip2("eip155:137")).toBe(true)
  })

  it("round-trips through format", () => {
    const c = parseCaip2("eip155:137")
    expect(formatCaip2(c)).toBe("eip155:137")
  })

  it("converts CAIP-2 ↔ EVM chainId", () => {
    expect(caip2ToEvmChainId("eip155:137")).toBe(137)
    expect(caip2ToEvmChainId("137")).toBe(137)
    expect(caip2ToEvmChainId(137)).toBe(137)
    expect(evmChainIdToCaip2(137)).toBe("eip155:137")
    expect(evmChainIdToCaip2(11155111)).toBe("eip155:11155111")
  })

  it("rejects non-EVM CAIP-2 in caip2ToEvmChainId", () => {
    expect(() => caip2ToEvmChainId("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp")).toThrow(/Not an EVM/)
  })

  it("rejects invalid chainIds", () => {
    expect(() => evmChainIdToCaip2(0)).toThrow()
    expect(() => evmChainIdToCaip2(-1)).toThrow()
    expect(() => evmChainIdToCaip2(1.5)).toThrow()
  })
})
