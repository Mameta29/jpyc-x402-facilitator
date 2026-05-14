/**
 * Workers Bindings + env shape.
 *
 * Wrangler injects these into `c.env` for Hono handlers and into
 * `env` for scheduled / DO entrypoints. Keeping the type centralised
 * means we get strict checks on env access from every file.
 */

import type { DurableObjectNamespace } from "@cloudflare/workers-types"

export interface WorkerEnv {
  // ── Vars (wrangler.jsonc) ──────────────────────────────────────────────
  NODE_ENV: "development" | "staging" | "production" | "test"
  ENABLED_NETWORKS: string
  CORS_ORIGINS: string

  // ── Secrets (wrangler secret put) ──────────────────────────────────────
  RELAYER_PRIVATE_KEY: string
  // Per-chain RPC URLs. Comma-separated lists for viem's fallback transport.
  // Each is optional; missing chains fall through to the public RPC baked
  // into @jpyc-x402/shared.
  RPC_URLS_1?: string
  RPC_URLS_137?: string
  RPC_URLS_43114?: string
  RPC_URLS_11155111?: string
  RPC_URLS_80002?: string
  RPC_URLS_43113?: string
  RPC_URLS_1001?: string
  RPC_URLS_5042002?: string

  // ── Durable Object namespace ───────────────────────────────────────────
  RELAYER: DurableObjectNamespace
}
