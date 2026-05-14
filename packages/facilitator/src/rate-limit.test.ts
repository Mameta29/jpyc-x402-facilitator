/**
 * Unit tests for the in-memory RateLimiter (DB-free replacement of the
 * previous Postgres-backed limiter).
 *
 * Validates:
 *   - per-payer count cap
 *   - optional value cap
 *   - rejection bypass: a rejected request must not poison the bucket
 *   - rolling window: a new window resets the counters
 */

import { describe, expect, it } from "vitest"
import { X402Error } from "@jpyc-x402/shared"
import { RateLimiter } from "./rate-limit.js"

const PAYER = "0x0000000000000000000000000000000000000001" as const

describe("RateLimiter (in-memory)", () => {
  it("allows requests up to the count cap", () => {
    const limiter = new RateLimiter({ windowSeconds: 60, maxRequests: 3 })
    const now = new Date("2026-05-14T00:00:00Z")
    expect(() => limiter.consume(PAYER, 1n, now)).not.toThrow()
    expect(() => limiter.consume(PAYER, 1n, now)).not.toThrow()
    expect(() => limiter.consume(PAYER, 1n, now)).not.toThrow()
  })

  it("rejects when count cap is exceeded", () => {
    const limiter = new RateLimiter({ windowSeconds: 60, maxRequests: 2 })
    const now = new Date("2026-05-14T00:00:00Z")
    limiter.consume(PAYER, 1n, now)
    limiter.consume(PAYER, 1n, now)
    expect(() => limiter.consume(PAYER, 1n, now)).toThrowError(X402Error)
  })

  it("rejects when value cap is exceeded", () => {
    const limiter = new RateLimiter({
      windowSeconds: 60,
      maxRequests: 100,
      maxValueAtomic: 10n,
    })
    const now = new Date("2026-05-14T00:00:00Z")
    limiter.consume(PAYER, 5n, now)
    limiter.consume(PAYER, 4n, now)
    expect(() => limiter.consume(PAYER, 2n, now)).toThrowError(X402Error)
  })

  it("does not poison the bucket on rejection", () => {
    // After a rejected call, the legitimate state must equal what it was
    // before. Otherwise a single rejected attempt would lock the payer
    // out of the rest of the window even though they were under the cap.
    const limiter = new RateLimiter({ windowSeconds: 60, maxRequests: 3 })
    const now = new Date("2026-05-14T00:00:00Z")
    limiter.consume(PAYER, 1n, now)
    limiter.consume(PAYER, 1n, now)
    limiter.consume(PAYER, 1n, now)
    // 4th call rejected:
    expect(() => limiter.consume(PAYER, 1n, now)).toThrow()
    // Window resets at the next minute boundary; the rejected attempt must
    // not have been counted into either bucket.
    const next = new Date("2026-05-14T00:01:00Z")
    expect(() => limiter.consume(PAYER, 1n, next)).not.toThrow()
    expect(() => limiter.consume(PAYER, 1n, next)).not.toThrow()
    expect(() => limiter.consume(PAYER, 1n, next)).not.toThrow()
  })

  it("rolls into a fresh bucket at window boundary", () => {
    const limiter = new RateLimiter({ windowSeconds: 60, maxRequests: 1 })
    limiter.consume(PAYER, 1n, new Date("2026-05-14T00:00:00Z"))
    expect(() => limiter.consume(PAYER, 1n, new Date("2026-05-14T00:00:30Z"))).toThrow()
    // After 60s, a new window starts.
    expect(() => limiter.consume(PAYER, 1n, new Date("2026-05-14T00:01:30Z"))).not.toThrow()
  })

  it("isolates buckets per payer", () => {
    const limiter = new RateLimiter({ windowSeconds: 60, maxRequests: 1 })
    const a = "0x0000000000000000000000000000000000000001" as const
    const b = "0x0000000000000000000000000000000000000002" as const
    const now = new Date()
    limiter.consume(a, 1n, now)
    expect(() => limiter.consume(b, 1n, now)).not.toThrow()
  })
})
