/**
 * Per-payer in-memory rate limiter.
 *
 * The DB-free refactor moved this from a Postgres-backed rolling-window
 * table to an in-process Map. The tradeoff is explicit:
 *
 *   - Single-replica deployments (Fly.io max-machines-running=1, Render
 *     Starter, a single Cloudflare Workers Durable Object instance) get
 *     consistent rate limiting with zero infra.
 *   - Multi-replica deployments need to either route by-payer to a single
 *     replica (sticky session) or upgrade to a shared store.
 *
 * The window is fixed-rolling (one entry per (payer, window_start)) — same
 * semantics as the previous Postgres version, just without the durability.
 *
 * Old entries are GC'd lazily on each `consume()` call; no separate sweep
 * is needed for the small N this serves.
 */

import {
  X402Error,
  FACILITATOR_INTERNAL_ERROR_CODES,
} from "@jpyc-x402/shared"
import type { Address } from "viem"

export interface RateLimitConfig {
  windowSeconds: number
  maxRequests: number
  maxValueAtomic?: bigint
}

interface Bucket {
  windowStartMs: number
  requestCount: number
  totalValueAtomic: bigint
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>()

  constructor(private readonly cfg: RateLimitConfig) {}

  /**
   * Reserve one slot in the bucket for `payer` consuming `valueAtomic` JPYC.
   * Throws X402Error if either the request count or the value cap is exceeded.
   */
  consume(payer: Address, valueAtomic: bigint, now: Date = new Date()): void {
    const windowMs = this.cfg.windowSeconds * 1000
    const windowStartMs = Math.floor(now.getTime() / windowMs) * windowMs
    const key = payer.toLowerCase()

    const existing = this.buckets.get(key)
    let bucket: Bucket
    if (!existing || existing.windowStartMs !== windowStartMs) {
      bucket = { windowStartMs, requestCount: 0, totalValueAtomic: 0n }
    } else {
      bucket = existing
    }

    const newCount = bucket.requestCount + 1
    const newTotal = bucket.totalValueAtomic + valueAtomic

    const overRequests = newCount > this.cfg.maxRequests
    const overValue =
      this.cfg.maxValueAtomic !== undefined && newTotal > this.cfg.maxValueAtomic

    if (overRequests || overValue) {
      // Persist nothing — bucket isn't updated, so the rejected request
      // doesn't poison the counter for this window.
      throw new X402Error(FACILITATOR_INTERNAL_ERROR_CODES.facilitator_rate_limited, {
        message: overRequests
          ? `payer ${payer} exceeded ${this.cfg.maxRequests} req / ${this.cfg.windowSeconds}s`
          : `payer ${payer} exceeded value cap in window`,
      })
    }

    bucket.requestCount = newCount
    bucket.totalValueAtomic = newTotal
    this.buckets.set(key, bucket)

    // Lazy GC: prune entries from older windows whenever we touch the map.
    // Keeps memory bounded without a separate timer.
    if (this.buckets.size > 1000) {
      for (const [k, b] of this.buckets) {
        if (b.windowStartMs < windowStartMs) this.buckets.delete(k)
      }
    }
  }

  /** Test helper: wipe state. */
  reset(): void {
    this.buckets.clear()
  }
}
