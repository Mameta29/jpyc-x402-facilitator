/**
 * Facilitator configuration loaded from environment variables.
 *
 * One module owns env reading; everything else takes a typed config value.
 * Tests construct a config directly so they can run without env mutation.
 */

import { z } from "zod"
import { caip2ToEvmChainId, listJpycChains } from "@jpyc-x402/shared"

export interface FacilitatorConfig {
  port: number
  nodeEnv: "development" | "staging" | "production" | "test"
  logLevel: "trace" | "debug" | "info" | "warn" | "error"
  databaseUrl: string
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
  otel: {
    endpoint?: string
    serviceName: string
  }
}

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8402),
  NODE_ENV: z.enum(["development", "staging", "production", "test"]).default("development"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
  DATABASE_URL: z.string().url().or(z.string().startsWith("postgres://")).or(z.string().startsWith("postgresql://")),
  ENABLED_NETWORKS: z.string().optional(),
  RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_MAX_VALUE_JPYC: z.string().optional(),
  RELAYER_BALANCE_LOW_NATIVE: z.coerce.number().nonnegative().default(0.05),
  RELAYER_BALANCE_CRITICAL_NATIVE: z.coerce.number().nonnegative().default(0.005),
  CORS_ORIGINS: z.string().default("*"),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
  OTEL_SERVICE_NAME: z.string().default("jpyc-x402-facilitator"),
})

export function loadConfig(env: NodeJS.ProcessEnv = process.env): FacilitatorConfig {
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

  return {
    port: parsed.PORT,
    nodeEnv: parsed.NODE_ENV,
    logLevel: parsed.LOG_LEVEL,
    databaseUrl: parsed.DATABASE_URL,
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
      origins: parsed.CORS_ORIGINS.split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    },
    otel: {
      endpoint: parsed.OTEL_EXPORTER_OTLP_ENDPOINT,
      serviceName: parsed.OTEL_SERVICE_NAME,
    },
  }
}
