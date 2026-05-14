/**
 * Facilitator configuration.
 *
 * The DB-free refactor reduced the surface to:
 *
 *   - HTTP server (port, log level, env, CORS)
 *   - Which networks to advertise
 *   - In-memory rate limit window + caps
 *   - Relayer balance thresholds
 *
 * No DATABASE_URL, no OTEL collector, no Postgres pooling. Operators wire
 * structured stdout into their log aggregator of choice (Workers Logs,
 * Logpush, Axiom, Better Stack, etc.) — facilitator does not own that path.
 */

import { z } from "zod"
import { caip2ToEvmChainId, listJpycChains } from "@jpyc-x402/shared"

export interface FacilitatorConfig {
  port: number
  nodeEnv: "development" | "staging" | "production" | "test"
  logLevel: "trace" | "debug" | "info" | "warn" | "error"
  enabledChainIds: number[]
  rateLimit: {
    windowSeconds: number
    maxRequests: number
    /** Optional value cap (atomic units, decimal string). Empty disables. */
    maxValueAtomic?: bigint
  }
  relayerBalance: {
    /** Per-chain native units below which we warn. */
    lowNative: number
    /** Per-chain native units below which we refuse to settle. */
    criticalNative: number
  }
  cors: {
    origins: string[]
  }
}

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8402),
  NODE_ENV: z.enum(["development", "staging", "production", "test"]).default("development"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
  ENABLED_NETWORKS: z.string().optional(),
  RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_MAX_VALUE_JPYC: z.string().optional(),
  RELAYER_BALANCE_LOW_NATIVE: z.coerce.number().nonnegative().default(0.05),
  RELAYER_BALANCE_CRITICAL_NATIVE: z.coerce.number().nonnegative().default(0.005),
  CORS_ORIGINS: z.string().default("*"),
})

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): FacilitatorConfig {
  const parsed = envSchema.parse(env)

  let enabledChainIds: number[]
  if (parsed.ENABLED_NETWORKS) {
    enabledChainIds = parsed.ENABLED_NETWORKS.split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map(caip2ToEvmChainId)
  } else if (parsed.NODE_ENV === "production") {
    enabledChainIds = listJpycChains({ mainnetOnly: true }).map((c) => c.chainId)
  } else if (parsed.NODE_ENV === "staging") {
    enabledChainIds = listJpycChains({ testnetOnly: true }).map((c) => c.chainId)
  } else {
    enabledChainIds = listJpycChains().map((c) => c.chainId)
  }

  const corsOrigins = parsed.CORS_ORIGINS.split(",")
    .map((s) => s.trim())
    .filter(Boolean)

  // Refuse to boot production with a wildcard CORS — too easy to leave the
  // dev default in by accident and let any origin POST signed payloads.
  // Operators who genuinely want a public open facilitator can set
  // CORS_ORIGINS to an explicit list including their public domain.
  if (parsed.NODE_ENV === "production" && corsOrigins.includes("*")) {
    throw new Error(
      "CORS_ORIGINS='*' is not allowed in production. " +
        "Set CORS_ORIGINS to an explicit comma-separated list of resource server origins.",
    )
  }

  return {
    port: parsed.PORT,
    nodeEnv: parsed.NODE_ENV,
    logLevel: parsed.LOG_LEVEL,
    enabledChainIds,
    rateLimit: {
      windowSeconds: parsed.RATE_LIMIT_WINDOW_SECONDS,
      maxRequests: parsed.RATE_LIMIT_MAX_REQUESTS,
      maxValueAtomic: parsed.RATE_LIMIT_MAX_VALUE_JPYC
        ? BigInt(parsed.RATE_LIMIT_MAX_VALUE_JPYC)
        : undefined,
    },
    relayerBalance: {
      lowNative: parsed.RELAYER_BALANCE_LOW_NATIVE,
      criticalNative: parsed.RELAYER_BALANCE_CRITICAL_NATIVE,
    },
    cors: {
      origins: corsOrigins,
    },
  }
}
