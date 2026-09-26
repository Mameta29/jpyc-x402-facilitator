/**
 * Production entry point for the JPYC x402 facilitator (Node).
 *
 * Legacy EIP-3009 composition:
 *   env config →
 *     ExactEvmFacilitator (verify+settle on EVM) →
 *     InProcessSettleRunner (per-chain mutex for nonce serialization) →
 *     RateLimiter (in-memory) →
 *     BalanceCache (in-memory, refreshed every 60 s) →
 *     Hono app
 *
 * Designed for single-machine deployments — Fly.io max-machines-running=1,
 * Render Starter, a self-hosted VPS. The optional ERC-7710 agent lane uses
 * a persistent SQLite journal and a dedicated relayer. Worker/DO hosts the
 * legacy lane only; it does not support agent execution.
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
  HmacAuthenticator,
  InProcessSettleRunner,
  NonceCache,
  RateLimiter,
  createApp,
  loadConfig,
  parseDiscoveryConfig,
} from "@jpyc-x402/facilitator"
import { getJpycChain } from "@jpyc-x402/shared"
import { createAgentRunner } from "./agent-bootstrap.js"

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
  const authenticator = new HmacAuthenticator({ keys: config.hmacKeys })
  const agentCommerce = await createAgentRunner()
  if (agentCommerce && !authenticator.hasKeys) throw new Error("Agent commerce requires HMAC authentication")
  let reconciling = false
  const agentTimer = agentCommerce ? setInterval(() => {
    if (reconciling) return
    reconciling = true
    void agentCommerce.reconcile().catch(() => console.error("[agent] reconciliation unavailable")).finally(() => { reconciling = false })
  }, 5000) : undefined
  agentTimer?.unref()
  console.info(
    `[startup] request auth: ${
      authenticator.hasKeys
        ? `${config.hmacKeys.length} HMAC key(s)`
        : "DISABLED (development only)"
    }`,
  )

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
    authenticator,
    ...(agentCommerce ? { agentCommerce } : {}),
    discovery: parseDiscoveryConfig(process.env.X402_DISCOVERY_RESOURCES) ?? undefined,
  })

  const hostname = process.env.HOST ?? "0.0.0.0"
  const server = serve({ fetch: app.fetch, port: config.port, hostname }, (info) => {
    console.info(`[startup] listening on http://${hostname}:${info.port}`)
    for (const id of config.enabledChainIds) {
      const c = getJpycChain(id)
      console.info(`  - ${c.shortName} (${id})  asset=${c.jpycAddress}`)
    }
  })

  const shutdown = async (signal: string) => {
    console.info(`[shutdown] received ${signal}`)
    clearInterval(balanceTimer)
    clearInterval(agentTimer)
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
