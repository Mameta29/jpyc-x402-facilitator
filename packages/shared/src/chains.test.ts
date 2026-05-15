import { describe, expect, it } from "vitest"
import {
  JPYC_CHAINS,
  JPYC_DECIMALS,
  getJpycChain,
  listJpycChains,
  tryGetJpycChain,
} from "./chains.js"

describe("JPYC chain registry", () => {
  it("registers exactly the chains the EC platform uses today", () => {
    const expected = [1, 137, 43114, 8217, 11155111, 80002, 43113, 1001].sort()
    const actual = JPYC_CHAINS.map((c) => c.chainId).sort()
    expect(actual).toEqual(expected)
  })

  it("uses one canonical JPYC address across all chains (operational policy)", () => {
    const addrs = new Set(JPYC_CHAINS.map((c) => c.jpycAddress.toLowerCase()))
    expect(addrs.size).toBe(1)
    expect([...addrs][0]).toBe("0xe7c3d8c9a439fede00d2600032d5db0be71c3c29")
  })

  it("uses the JPYC EIP-712 domain (name=JPY Coin, version=1) on every chain", () => {
    for (const c of JPYC_CHAINS) {
      expect(c.jpycDomainName).toBe("JPY Coin")
      expect(c.jpycDomainVersion).toBe("1")
    }
  })

  it("looks up by chainId and CAIP-2 with O(1) accessors", () => {
    expect(getJpycChain(137).shortName).toBe("Polygon")
    expect(getJpycChain("eip155:137").shortName).toBe("Polygon")
    expect(getJpycChain(80002).isTestnet).toBe(true)
    expect(tryGetJpycChain(99999)).toBeUndefined()
    expect(() => getJpycChain(99999)).toThrow(/Unsupported/)
  })

  it("filters mainnets and testnets correctly", () => {
    const mains = listJpycChains({ mainnetOnly: true })
    const tests = listJpycChains({ testnetOnly: true })
    expect(mains.every((c) => !c.isTestnet)).toBe(true)
    expect(tests.every((c) => c.isTestnet)).toBe(true)
    expect(mains.length + tests.length).toBe(JPYC_CHAINS.length)
  })

  it("defines decimals as 18", () => {
    expect(JPYC_DECIMALS).toBe(18)
  })
})
