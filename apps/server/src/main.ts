/**
 * Production entry point for the JPYC x402 facilitator (Node).
 *
 * DB-free composition:
 *   env config →
 *     ExactEvmFacilitator (verify+settle on EVM) →
 *     InProcessSettleRunner (per-chain mutex for nonce serialization) →
 *     RateLimiter (in-memory) →
 *     BalanceCache (in-memory, refreshed every 60 s) →
 *     Hono app
 *
 * Designed for single-machine deployments — Fly.io max-machines-running=1,
 * Render Starter, a self-hosted VPS. For multi-replica deployments use the
 * Cloudflare Workers app (apps/worker) which serializes via Durable Objects.
 */

import { serve } from "@hono/node-server"
import {
  ExactEvmFacilitator,
  buildPublicClient,
  envPrivateKeyRelayerProvider,
  envRpcResolver,
} from "@jpyc-x402/evm"
import {
  BalanceCache,
  InProcessSettleRunner,
  NonceCache,
  RateLimiter,
  createApp,
  loadConfig,
} from "@jpyc-x402/facilitator"
import { getJpycChain } from "@jpyc-x402/shared"

async function main() {
  const config = loadConfig()
  console.info(`[startup] env=${config.nodeEnv} chains=${config.enabledChainIds.join(",")}`)

  const rpcResolver = envRpcResolver()
  const signerProvider = envPrivateKeyRelayerProvider()

  const facilitator = new ExactEvmFacilitator({
    enabledChainIds: config.enabledChainIds,
    rpcResolver,
    signerProvider,
  })

  const settleRunner = new InProcessSettleRunner(facilitator)
  const rateLimiter = new RateLimiter(config.rateLimit)
  const nonceCache = new NonceCache(/* ttlSeconds */ 300)
  const balanceCache = new BalanceCache(config.relayerBalance)

  // Refresh balance for every enabled chain at boot, then on a 60s interval.
  // Per-chain failures are isolated; one dead RPC doesn't stop startup.
  const monitored = config.enabledChainIds.map((chainId) => ({
    chainId,
    publicClient: buildPublicClient(chainId, rpcResolver),
    account: signerProvider.forChain(chainId),
  }))
  await balanceCache.refreshAll(monitored).catch((e: unknown) => {
    console.error("[startup] balance refresh failed:", e)
  })
  const balanceTimer = setInterval(() => {
    void balanceCache.refreshAll(monitored).catch((e: unknown) => {
      console.error("[balance] refresh failed:", e)
    })
  }, 60_000)
  balanceTimer.unref()

  const app = createApp({
    facilitator,
    settleRunner,
    rateLimiter,
    nonceCache,
    balanceCache,
    cors: config.cors,
    nodeEnv: config.nodeEnv,
  })

  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.info(`[startup] listening on http://0.0.0.0:${info.port}`)
    for (const id of config.enabledChainIds) {
      const c = getJpycChain(id)
      console.info(`  - ${c.shortName} (${id})  asset=${c.jpycAddress}`)
    }
  })

  const shutdown = async (signal: string) => {
    console.info(`[shutdown] received ${signal}`)
    clearInterval(balanceTimer)
    server.close(() => {
      console.info(`[shutdown] all in-flight requests drained, exiting clean`)
      process.exit(0)
    })
    setTimeout(() => {
      console.warn(
        `[shutdown] force exit after 10s grace period — in-flight settle ` +
          `requests may have been cut off mid-broadcast. Inspect logs above ` +
          `for any settle.ok lines without a matching downstream confirmation.`,
      )
      process.exit(1)
    }, 10_000).unref()
  }
  process.on("SIGTERM", () => void shutdown("SIGTERM"))
  process.on("SIGINT", () => void shutdown("SIGINT"))
}

void main().catch((e: unknown) => {
  console.error("[fatal]", e)
  process.exit(1)
})
