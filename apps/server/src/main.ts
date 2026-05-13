/**
 * Production entry point for the JPYC x402 facilitator.
 *
 * Wires the env-derived config into the database, RPC clients, signer
 * provider, balance monitor, and rate limiter, then serves the Hono app
 * over `@hono/node-server`. Graceful shutdown drains in-flight requests.
 */

import { serve } from "@hono/node-server"
import {
  ExactEvmFacilitator,
  buildPublicClient,
  envPrivateKeyRelayerProvider,
  envRpcResolver,
} from "@jpyc-x402/evm"
import {
  BalanceMonitor,
  RateLimiter,
  createApp,
  createDatabase,
  loadConfig,
} from "@jpyc-x402/facilitator"
import { getJpycChain } from "@jpyc-x402/shared"

async function main() {
  const config = loadConfig()
  console.log(`[startup] env=${config.nodeEnv} chains=${config.enabledChainIds.join(",")}`)

  const { db, pool } = createDatabase(config.databaseUrl)
  const rpcResolver = envRpcResolver()
  const signerProvider = envPrivateKeyRelayerProvider()

  const facilitator = new ExactEvmFacilitator({
    enabledChainIds: config.enabledChainIds,
    rpcResolver,
    signerProvider,
  })

  const balanceMonitor = new BalanceMonitor(db, config.relayerBalance)

  // Refresh balance for every enabled chain at boot, then on a 60s interval.
  // We catch errors per-chain so one dead RPC doesn't block startup.
  const monitored = config.enabledChainIds.map((chainId) => ({
    chainId,
    publicClient: buildPublicClient(chainId, rpcResolver),
    account: signerProvider.forChain(chainId),
  }))
  await balanceMonitor.refreshAll(monitored).catch((e) => {
    console.error("[startup] balance refresh failed:", e)
  })
  const balanceTimer = setInterval(() => {
    void balanceMonitor.refreshAll(monitored).catch((e) => {
      console.error("[balance] refresh failed:", e)
    })
  }, 60_000)
  balanceTimer.unref()

  const rateLimiter = new RateLimiter(db, config.rateLimit)
  const app = createApp({
    facilitator,
    db,
    rateLimiter,
    balanceMonitor,
    cors: config.cors,
    nodeEnv: config.nodeEnv,
  })

  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`[startup] listening on http://0.0.0.0:${info.port}`)
    for (const id of config.enabledChainIds) {
      const c = getJpycChain(id)
      console.log(`  - ${c.shortName} (${id})  asset=${c.jpycAddress}`)
    }
  })

  const shutdown = async (signal: string) => {
    console.log(`[shutdown] received ${signal}`)
    clearInterval(balanceTimer)
    server.close(async () => {
      await pool.end().catch(() => {})
      process.exit(0)
    })
    setTimeout(() => process.exit(1), 10_000).unref()
  }
  process.on("SIGTERM", () => void shutdown("SIGTERM"))
  process.on("SIGINT", () => void shutdown("SIGINT"))
}

void main().catch((e) => {
  console.error("[fatal]", e)
  process.exit(1)
})
