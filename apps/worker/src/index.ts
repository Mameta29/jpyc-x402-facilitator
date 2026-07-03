/**
 * Cloudflare Workers entrypoint for the JPYC x402 facilitator.
 *
 * One module exports:
 *   - default fetch handler: builds the Hono app per request, serves /verify,
 *     /settle, /supported, /health
 *   - default scheduled handler: refreshes the in-memory balance cache for
 *     each enabled chain (cron triggered by wrangler.jsonc)
 *   - RelayerSignerDO: the Durable Object class consumed via `env.RELAYER`
 *
 * State scoping: the rate limiter, nonce dedupe cache, HMAC replay store and
 * balance cache are held at *isolate* scope (module-level, reused across
 * requests in the same isolate) — NOT rebuilt per request. Rebuilding them per
 * request would reset every counter on each call, so per-payer rate limiting,
 * nonce dedupe and HMAC replay detection would never fire. This is still only
 * per-isolate, not global:
 *
 *   - Rate limit / nonce dedupe / HMAC replay are per-isolate best-effort.
 *     Cloudflare runs many isolates concurrently, so a caller spreading load
 *     across isolates weakens these. The authoritative broadcast serialization
 *     is the per-chain RelayerSignerDO (`blockConcurrencyWhile`), and the
 *     JPYC contract's `authorizationState` is the final replay guard — a
 *     duplicate broadcast costs at most one revert's gas, never correctness.
 *     Operators MUST also enforce per-IP / per-route limits at the Cloudflare
 *     WAF layer; see docs/threat-model.md.
 *   - Balance cache is refreshed by the scheduled handler regardless of which
 *     isolate is active; missing entries fall back to "not critical" so we
 *     never refuse a settle on stale data alone.
 */

import {
  ExactEvmFacilitator,
  buildPublicClient,
  privateKeyRelayerProvider,
} from "@jpyc-x402/evm"
import {
  BalanceCache,
  HmacAuthenticator,
  NonceCache,
  RateLimiter,
  createApp,
  loadConfig,
  parseDiscoveryConfig,
} from "@jpyc-x402/facilitator"
import { caip2ToEvmChainId } from "@jpyc-x402/shared"
import type { Hex } from "viem"
import type { WorkerEnv } from "./env"
import { workerRpcResolver } from "./rpc"
import { WorkerSettleRunner } from "./worker-settle-runner"

// Re-export the DO class so wrangler can find it.
export { RelayerSignerDO } from "./relayer-signer-do"

// Isolate-scoped, stateful singletons. These MUST persist across requests in
// the same isolate — see module header. Rebuilding them per request would
// reset every counter and defeat rate limiting / nonce dedupe / HMAC replay.
// Not shared across isolates (per-isolate best-effort; WAF + DO are the
// authoritative layers).
const isolateState = (() => {
  let state: {
    balance: BalanceCache
    rateLimiter: RateLimiter
    nonceCache: NonceCache
    authenticator: HmacAuthenticator
  } | null = null
  return {
    getOrInit(config: ReturnType<typeof loadConfig>): NonNullable<typeof state> {
      if (state) return state
      state = {
        // Defaults are loaded on first init and reused; thresholds rarely
        // change at runtime, and re-reading env on every request would
        // mask config drift.
        balance: new BalanceCache({ lowNative: 0.05, criticalNative: 0.005 }),
        rateLimiter: new RateLimiter(config.rateLimit),
        nonceCache: new NonceCache(/* ttlSeconds */ 300),
        authenticator: new HmacAuthenticator({ keys: config.hmacKeys }),
      }
      return state
    },
  }
})()

interface CtorBundle {
  facilitator: ExactEvmFacilitator
  runner: WorkerSettleRunner
  rateLimiter: RateLimiter
  nonceCache: NonceCache
  balanceCache: BalanceCache
  authenticator: HmacAuthenticator
  config: ReturnType<typeof loadConfig>
}

function buildBundle(env: WorkerEnv): CtorBundle {
  // loadConfig reads from a Record<string,string|undefined>; Workers env is
  // already shaped that way for vars/secrets, so we coerce.
  const config = loadConfig(env as unknown as Record<string, string | undefined>)
  const rpcResolver = workerRpcResolver(env)

  // The Worker's relayer provider is the same private key passed via secret;
  // the DO uses the same key when it actually signs. The Worker side just
  // needs an Account for the verify-time simulate step to match what the DO
  // would broadcast.
  const signerProvider = privateKeyRelayerProvider({
    defaultPrivateKey: env.RELAYER_PRIVATE_KEY as Hex,
  })
  const facilitator = new ExactEvmFacilitator({
    enabledChainIds: config.enabledChainIds,
    rpcResolver,
    signerProvider,
  })

  const runner = new WorkerSettleRunner(env, facilitator, rpcResolver)

  // Stateful singletons come from isolate scope so their counters survive
  // across requests in this isolate (rate limit, nonce dedupe, HMAC replay).
  const state = isolateState.getOrInit(config)

  return {
    facilitator,
    runner,
    rateLimiter: state.rateLimiter,
    nonceCache: state.nonceCache,
    balanceCache: state.balance,
    authenticator: state.authenticator,
    config,
  }
}

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    const bundle = buildBundle(env)
    const app = createApp({
      facilitator: bundle.facilitator,
      settleRunner: bundle.runner,
      rateLimiter: bundle.rateLimiter,
      nonceCache: bundle.nonceCache,
      balanceCache: bundle.balanceCache,
      cors: bundle.config.cors,
      nodeEnv: bundle.config.nodeEnv,
      authenticator: bundle.authenticator,
      discovery: parseDiscoveryConfig(env.X402_DISCOVERY_RESOURCES) ?? undefined,
    })
    return app.fetch(request, env as unknown as Record<string, unknown>, ctx)
  },

  /**
   * Cron-driven balance refresh. Runs every minute (wrangler.jsonc cron).
   * Per-chain failures are isolated; we don't want one dead RPC to block the
   * other chains' refresh.
   */
  async scheduled(_event: ScheduledEvent, env: WorkerEnv, ctx: ExecutionContext): Promise<void> {
    const bundle = buildBundle(env)
    const monitored = bundle.config.enabledChainIds.map((chainId) => ({
      chainId,
      publicClient: buildPublicClient(chainId, workerRpcResolver(env)),
      account: privateKeyRelayerProvider({
        defaultPrivateKey: env.RELAYER_PRIVATE_KEY as Hex,
      }).forChain(chainId),
    }))
    ctx.waitUntil(
      bundle.balanceCache.refreshAll(monitored).catch((e) => {
        console.error("[scheduled] balance refresh failed:", e)
      }),
    )
  },
}
