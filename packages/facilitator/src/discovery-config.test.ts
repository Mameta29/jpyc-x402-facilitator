import { describe, expect, it } from "vitest"
import { parseDiscoveryConfig } from "./discovery-config.js"

const validResource = {
  resource: "https://ec.jpyc-service.com/api/v1/checkout",
  type: "http",
  x402Version: 2,
  accepts: [
    {
      scheme: "exact",
      network: "eip155:137",
      amount: "1000000000000000000000",
      asset: "0x431D5dfF03120AFA4bDf332c61A6e1766eF37BDB",
      payTo: "0xAaBbCcDdEeFf00112233445566778899AABBCCDD",
      maxTimeoutSeconds: 90,
      extra: { assetTransferMethod: "eip3009", name: "JPY Coin", version: "1" },
    },
  ],
  lastUpdated: "2026-05-16T00:00:00Z",
  metadata: { description: "JPYC EC checkout" },
}

describe("parseDiscoveryConfig", () => {
  it("returns null for an absent value (discovery disabled)", () => {
    expect(parseDiscoveryConfig(undefined)).toBeNull()
    expect(parseDiscoveryConfig("")).toBeNull()
    expect(parseDiscoveryConfig("   ")).toBeNull()
  })

  it("returns null for non-JSON input", () => {
    expect(parseDiscoveryConfig("not json")).toBeNull()
  })

  it("returns null when the catalog fails schema validation", () => {
    // An object instead of an array.
    expect(parseDiscoveryConfig(JSON.stringify({ foo: 1 }))).toBeNull()
    // An array with a malformed resource (missing accepts).
    expect(
      parseDiscoveryConfig(JSON.stringify([{ resource: "x", type: "http", x402Version: 2 }])),
    ).toBeNull()
  })

  it("parses a valid catalog", () => {
    const result = parseDiscoveryConfig(JSON.stringify([validResource]))
    expect(result).not.toBeNull()
    expect(result!.resources).toHaveLength(1)
    expect(result!.resources[0]!.resource).toBe(
      "https://ec.jpyc-service.com/api/v1/checkout",
    )
  })

  it("parses an empty array as an empty catalog", () => {
    const result = parseDiscoveryConfig("[]")
    expect(result).not.toBeNull()
    expect(result!.resources).toEqual([])
  })
})
