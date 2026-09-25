import { describe, it, expect } from "vitest"
import { relayerChainKeys, usesDurableSettlement } from "../src/relayer-config"
import { privateKeyRelayerProvider } from "@jpyc-x402/evm"

describe("chain-scoped durable rollout", () => {
  it("leaves other chains on the compatibility path", () => {
    const env = { DURABLE_SETTLEMENT_CHAINS: "1001,11155111" }
    expect(usesDurableSettlement(env, 1001)).toBe(true)
    expect(usesDurableSettlement(env, 11155111)).toBe(true)
    expect(usesDurableSettlement(env, 80002)).toBe(false)
    expect(usesDurableSettlement(env, 43113)).toBe(false)
  })
  it("preserves the durable default and fails closed on malformed configuration", () => {
    expect(usesDurableSettlement({}, 1001)).toBe(true)
    expect(() => usesDurableSettlement({ DURABLE_SETTLEMENT_CHAINS: "1001,typo" }, 1001)).toThrow()
    for (const value of ["not json", "[]", '{"1001":"secret"}', '{"bad":"0x' + "1".repeat(64) + '"}'])
      expect(() => relayerChainKeys({ RELAYER_CHAIN_PRIVATE_KEYS: value })).toThrow("invalid_relayer_chain_keys")
  })
  it("only overrides the selected chain key", () => {
    const key = `0x${"2".repeat(64)}` as const
    expect(relayerChainKeys({})).toEqual({})
    expect(relayerChainKeys({ RELAYER_CHAIN_PRIVATE_KEYS: JSON.stringify({ 1001: key }) })).toEqual({ 1001: key })
    const provider = privateKeyRelayerProvider({ defaultPrivateKey: `0x${"1".repeat(64)}`,
      perChain: relayerChainKeys({ RELAYER_CHAIN_PRIVATE_KEYS: JSON.stringify({ 1001: key }) }) })
    expect(provider.forChain(1001).address).not.toBe(provider.forChain(80002).address)
    expect(provider.forChain(80002).address).toBe(provider.forChain(43113).address)
  })
})
