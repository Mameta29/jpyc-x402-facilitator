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
 * The handler is stateless across requests — every Worker isolate gets its
 * own facilitator/runner/cache instances. That's fine because:
 *
 *   - Rate limit per isolate is conservative: a hot wallet hitting many
 *     isolates concurrently still tops out at the global RPC limits.
 *   - The nonce dedupe cache is best-effort only; the contract is the source
 *     of truth, and a duplicate broadcast costs at most one revert worth of
 *     gas, not money or correctness.
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
  NonceCache,
  RateLimiter,
  createApp,
  loadConfig,
} from "@jpyc-x402/facilitator"
import { caip2ToEvmChainId } from "@jpyc-x402/shared"
import type { Hex } from "viem"
import type { WorkerEnv } from "./env"
import { workerRpcResolver } from "./rpc"
import { WorkerSettleRunner } from "./worker-settle-runner"

// Re-export the DO class so wrangler can find it.
export { RelayerSignerDO } from "./relayer-signer-do"

// One global cache per isolate; survives between requests in the same isolate
// but is not shared across isolates. That's intentional — see module header.
const isolateState = (() => {
  let cache: { balance: BalanceCache } | null = null
  return {
    getOrInit(): { balance: BalanceCache } {
      if (cache) return cache
      cache = {
        // Defaults are loaded on first init and reused; thresholds rarely
        // change at runtime, and re-reading env on every request would
        // mask config drift.
        balance: new BalanceCache({ lowNative: 0.05, criticalNative: 0.005 }),
      }
      return cache
    },
  }
})()

interface CtorBundle {
  facilitator: ExactEvmFacilitator
  runner: WorkerSettleRunner
  rateLimiter: RateLimiter
  nonceCache: NonceCache
  balanceCache: BalanceCache
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
  const rateLimiter = new RateLimiter(config.rateLimit)
  const nonceCache = new NonceCache(/* ttlSeconds */ 300)
  const balanceCache = isolateState.getOrInit().balance

  return { facilitator, runner, rateLimiter, nonceCache, balanceCache, config }
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
