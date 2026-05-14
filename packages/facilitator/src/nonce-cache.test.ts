/**
 * Unit tests for the in-memory NonceCache.
 *
 * The cache is a gas/latency optimisation, not a security boundary — the
 * EIP-3009 contract enforces per-(payer, nonce) uniqueness. We're just
 * making sure the cache returns sane records for the optimisation path.
 */

import { describe, expect, it } from "vitest"
import { NonceCache } from "./nonce-cache.js"

const CHAIN = 137
const PAYER = "0xCustomer000000000000000000000000000000Cust"
const NONCE = "0x" + "ab".repeat(32)

describe("NonceCache", () => {
  it("returns undefined for unseen triples", () => {
    const cache = new NonceCache()
    expect(cache.get(CHAIN, PAYER, NONCE)).toBeUndefined()
  })

  it("remembers + reads a triple", () => {
    const cache = new NonceCache()
    cache.remember(CHAIN, PAYER, NONCE, { settled: true, txHash: "0xabc" })
    const got = cache.get(CHAIN, PAYER, NONCE)
    expect(got?.settled).toBe(true)
    expect(got?.txHash).toBe("0xabc")
  })

  it("preserves firstSeenMs across remembers", () => {
    const cache = new NonceCache()
    cache.remember(CHAIN, PAYER, NONCE)
    const first = cache.get(CHAIN, PAYER, NONCE)?.firstSeenMs
    cache.remember(CHAIN, PAYER, NONCE, { settled: true, txHash: "0xdef" })
    const second = cache.get(CHAIN, PAYER, NONCE)
    expect(second?.firstSeenMs).toBe(first)
    expect(second?.lastSeenMs).toBeGreaterThanOrEqual(first ?? 0)
    expect(second?.txHash).toBe("0xdef")
  })

  it("treats payer + nonce as case-insensitive", () => {
    const cache = new NonceCache()
    cache.remember(CHAIN, PAYER.toUpperCase(), NONCE, { settled: true })
    expect(cache.get(CHAIN, PAYER.toLowerCase(), NONCE.toUpperCase())).toBeDefined()
  })

  it("isolates by chain", () => {
    const cache = new NonceCache()
    cache.remember(137, PAYER, NONCE, { settled: true, txHash: "0xpoly" })
    cache.remember(1, PAYER, NONCE, { settled: true, txHash: "0xeth" })
    expect(cache.get(137, PAYER, NONCE)?.txHash).toBe("0xpoly")
    expect(cache.get(1, PAYER, NONCE)?.txHash).toBe("0xeth")
  })

  it("expires entries past the TTL", () => {
    const cache = new NonceCache(/* ttlSeconds */ 1)
    cache.remember(CHAIN, PAYER, NONCE, { settled: true })
    expect(cache.get(CHAIN, PAYER, NONCE)).toBeDefined()
    // Wait the TTL out (1s) — vitest's fake timers add complexity vs reading
    // the path; we use Date.now manipulation indirectly by mutating firstSeenMs.
    const entry = cache.get(CHAIN, PAYER, NONCE)
    if (entry) entry.firstSeenMs = Date.now() - 5000
    expect(cache.get(CHAIN, PAYER, NONCE)).toBeUndefined()
  })
})
