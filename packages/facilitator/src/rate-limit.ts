/**
 * Per-payer rate limiter.
 *
 * The store is Postgres-backed so multiple facilitator replicas share the
 * same view of who has spent what in the current window. This is intentional:
 * an in-memory limiter would let an attacker round-robin requests across
 * replicas to bypass the cap.
 *
 * The window is fixed-rolling (one row per (payer, window_start)) — simpler
 * to reason about than sliding windows, and good enough for "stop a single
 * wallet from running away with 10k tx in a minute" use cases.
 */

import { sql } from "drizzle-orm"
import type { Address } from "viem"
import { rateLimitBuckets, type Database } from "./db/index.js"
import {
  X402Error,
  FACILITATOR_INTERNAL_ERROR_CODES,
} from "@jpyc-x402/shared"

export interface RateLimitConfig {
  windowSeconds: number
  maxRequests: number
  maxValueAtomic?: bigint
}

export class RateLimiter {
  constructor(
    private readonly db: Database,
    private readonly cfg: RateLimitConfig,
  ) {}

  /**
   * Reserve one slot in the bucket for `payer` consuming `valueAtomic` JPYC.
   * Throws X402Error if either the request count or the value cap is exceeded.
   *
   * The reservation is atomic: we upsert the bucket and read back the new
   * totals in a single round trip, then compare. If the new totals exceed the
   * cap we roll back by decrementing — this is a best-effort "soft refund"
   * because Postgres can't natively transact + read in one statement.
   */
  async consume(payer: Address, valueAtomic: bigint, now: Date = new Date()): Promise<void> {
    const windowMs = this.cfg.windowSeconds * 1000
    const windowStart = new Date(Math.floor(now.getTime() / windowMs) * windowMs)
    const inserted = await this.db
      .insert(rateLimitBuckets)
      .values({
        payer: payer.toLowerCase(),
        windowStart,
        requestCount: 1,
        totalValueAtomic: valueAtomic.toString(),
      })
      .onConflictDoUpdate({
        target: [rateLimitBuckets.payer, rateLimitBuckets.windowStart],
        set: {
          requestCount: sql`${rateLimitBuckets.requestCount} + 1`,
          totalValueAtomic: sql`${rateLimitBuckets.totalValueAtomic} + ${valueAtomic.toString()}`,
        },
      })
      .returning({
        requestCount: rateLimitBuckets.requestCount,
        totalValueAtomic: rateLimitBuckets.totalValueAtomic,
      })

    const row = inserted[0]
    if (!row) {
      // Should be unreachable — UPSERT always returns a row — but defensive.
      throw new X402Error(FACILITATOR_INTERNAL_ERROR_CODES.facilitator_rate_limited, {
        message: "rate limit bucket missing after upsert",
      })
    }

    const overRequests = row.requestCount > this.cfg.maxRequests
    const overValue =
      this.cfg.maxValueAtomic !== undefined &&
      BigInt(row.totalValueAtomic) > this.cfg.maxValueAtomic

    if (overRequests || overValue) {
      // Soft refund.
      await this.db
        .update(rateLimitBuckets)
        .set({
          requestCount: sql`GREATEST(${rateLimitBuckets.requestCount} - 1, 0)`,
          totalValueAtomic: sql`GREATEST(${rateLimitBuckets.totalValueAtomic}::numeric - ${valueAtomic.toString()}, 0)`,
        })
        .where(
          sql`${rateLimitBuckets.payer} = ${payer.toLowerCase()} AND ${rateLimitBuckets.windowStart} = ${windowStart}`,
        )

      throw new X402Error(FACILITATOR_INTERNAL_ERROR_CODES.facilitator_rate_limited, {
        message: overRequests
          ? `payer ${payer} exceeded ${this.cfg.maxRequests} req / ${this.cfg.windowSeconds}s`
          : `payer ${payer} exceeded value cap in window`,
      })
    }
  }
}
