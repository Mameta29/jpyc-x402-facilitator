/**
 * Hono app exposing the x402 facilitator REST surface.
 *
 * Routes:
 *   GET  /health     — liveness for the load balancer
 *   GET  /supported  — advertise (scheme, network) kinds we serve
 *   POST /verify     — verify a PaymentPayload against PaymentRequirements
 *   POST /settle     — verify + broadcast transferWithAuthorization
 *
 * The DB-free refactor moved every persistent piece in-memory or out of
 * scope:
 *   - rate limiting → in-memory token bucket (RateLimiter)
 *   - relayer balance health → in-memory cache (BalanceCache), refreshed by
 *     the host on a timer (Node) or scheduled trigger (Workers)
 *   - settle dedupe → in-memory short-TTL cache (NonceCache); the contract's
 *     `_authorizationStates` mapping is the authoritative source of truth.
 *
 * Concurrency: nonce serialization is delegated to the SettleRunner the host
 * provides. In Node we ship InProcessSettleRunner (per-chain mutex). In
 * Workers the worker app injects a Durable Object-backed runner.
 */

import { Hono, type Context } from "hono"
import { cors } from "hono/cors"
import { logger as honoLogger } from "hono/logger"
import {
  X402Error,
  caip2ToEvmChainId,
  settleRequestSchema,
  verifyRequestSchema,
  X402_VERSION,
  type SettlementResponse,
  type SupportedResponse,
  type VerifyResponse,
} from "@jpyc-x402/shared"
import type { ExactEvmFacilitator } from "@jpyc-x402/evm"
import type { Address } from "viem"
import { RateLimiter } from "./rate-limit.js"
import { BalanceCache } from "./balance-cache.js"
import { NonceCache } from "./nonce-cache.js"
import type { SettleRunner } from "./settle-runner.js"

export interface AppDeps {
  facilitator: ExactEvmFacilitator
  settleRunner: SettleRunner
  rateLimiter: RateLimiter
  nonceCache: NonceCache
  balanceCache?: BalanceCache
  cors: { origins: string[] }
  /** Node env, used to gate verbose error responses. */
  nodeEnv: "development" | "staging" | "production" | "test"
}

export function createApp(deps: AppDeps) {
  const app = new Hono()

  app.use("*", honoLogger())
  app.use(
    "*",
    cors({
      origin: deps.cors.origins.includes("*") ? "*" : deps.cors.origins,
      allowHeaders: ["Content-Type", "PAYMENT-SIGNATURE"],
      exposeHeaders: ["PAYMENT-REQUIRED", "PAYMENT-RESPONSE"],
    }),
  )

  app.get("/health", (c) => c.json({ ok: true }))

  app.get("/supported", (c) => {
    const body: SupportedResponse = {
      kinds: deps.facilitator.supported(),
      extensions: [],
      signers: deps.facilitator.signers(),
    }
    return c.json(body)
  })

  app.post("/verify", async (c) => {
    try {
      const json = await c.req.json()
      const parsed = verifyRequestSchema.parse(json)
      const result = await deps.facilitator.verify(
        parsed.paymentPayload,
        parsed.paymentRequirements,
      )
      const response: VerifyResponse = result.ok
        ? { isValid: true, payer: result.payer }
        : {
            isValid: false,
            invalidReason: shortReason(result.reason),
            ...(result.payer ? { payer: result.payer } : {}),
          }
      return c.json(response)
    } catch (e) {
      return errorToVerifyResponse(c, e, deps.nodeEnv)
    }
  })

  app.post("/settle", async (c) => {
    try {
      const json = await c.req.json()
      const parsed = settleRequestSchema.parse(json)

      const payer = parsed.paymentPayload.payload.authorization.from as Address
      const valueAtomic = BigInt(parsed.paymentPayload.payload.authorization.value)

      // 1) Rate limit before any RPC work.
      deps.rateLimiter.consume(payer, valueAtomic)

      const chainId = caip2ToEvmChainId(parsed.paymentRequirements.network)
      const nonce = parsed.paymentPayload.payload.authorization.nonce

      // 2) Nonce cache — if we already settled this exact triple within the
      //    cache window, return the cached tx hash without re-broadcasting.
      //    Truth is on-chain (`_authorizationStates`); this just saves gas
      //    and a round-trip when callers retry.
      const cached = deps.nonceCache.get(chainId, payer, nonce)
      if (cached?.settled && cached.txHash) {
        const body: SettlementResponse = {
          success: true,
          payer,
          transaction: cached.txHash,
          network: parsed.paymentRequirements.network,
          amount: valueAtomic.toString(),
        }
        return c.json(body)
      }

      // 3) Balance gate — refuse to settle when the relayer is critically low.
      const refuseForBalance = deps.balanceCache?.isCritical(chainId) ?? false
      if (refuseForBalance) {
        const body: SettlementResponse = {
          success: false,
          errorReason: "facilitator_insufficient_native_balance",
          payer,
          transaction: "",
          network: parsed.paymentRequirements.network,
        }
        return c.json(body, 503)
      }

      // 4) Run the actual verify + settle through the host's SettleRunner.
      //    This is where Node and Workers diverge: Node uses a per-chain
      //    in-process mutex, Workers forwards to a Durable Object.
      const result = await deps.settleRunner.settle(
        parsed.paymentPayload,
        parsed.paymentRequirements,
      )

      if (!result.verify.ok) {
        const body: SettlementResponse = {
          success: false,
          errorReason: shortReason(result.verify.reason),
          payer: result.verify.payer ?? payer,
          transaction: "",
          network: parsed.paymentRequirements.network,
        }
        return c.json(body)
      }

      const settle = result.settle!
      if (!settle.ok) {
        // Don't cache failures — caller may retry after fixing balance/RPC.
        const body: SettlementResponse = {
          success: false,
          errorReason: shortReason(settle.reason),
          payer,
          transaction: settle.txHash ?? "",
          network: parsed.paymentRequirements.network,
        }
        return c.json(body)
      }

      // Cache the success — replays within TTL hit fast path above.
      deps.nonceCache.remember(chainId, payer, nonce, {
        settled: true,
        txHash: settle.txHash,
      })

      // Structured success log so operators have an audit trail without DB.
      console.info(
        JSON.stringify({
          ev: "settle.ok",
          chainId,
          payer,
          payTo: parsed.paymentRequirements.payTo,
          valueAtomic: valueAtomic.toString(),
          nonce,
          txHash: settle.txHash,
          gasCostNative: settle.gasCostNative,
        }),
      )

      const body: SettlementResponse = {
        success: true,
        payer,
        transaction: settle.txHash,
        network: parsed.paymentRequirements.network,
        amount: valueAtomic.toString(),
      }
      return c.json(body)
    } catch (e) {
      return await errorToSettleResponse(c, e, deps.nodeEnv)
    }
  })

  app.get("/", (c) =>
    c.json({
      name: "jpyc-x402-facilitator",
      x402Version: X402_VERSION,
      enabledNetworks: deps.facilitator.supported().map((k) => k.network),
    }),
  )

  return app
}

function shortReason(reason: string): string {
  const colon = reason.indexOf(":")
  if (colon > 0 && colon < 80) return reason.slice(0, colon)
  return reason
}

type ContentfulStatus = 200 | 400 | 402 | 429 | 500 | 503
function asStatus(n: number): ContentfulStatus {
  if (n === 200 || n === 400 || n === 402 || n === 429 || n === 500 || n === 503) {
    return n
  }
  return 400
}

function errorToVerifyResponse(c: Context, e: unknown, nodeEnv: AppDeps["nodeEnv"]) {
  if (e instanceof X402Error) {
    const body: VerifyResponse = { isValid: false, invalidReason: e.code }
    return c.json(body, asStatus(e.httpStatus))
  }
  const body: VerifyResponse = {
    isValid: false,
    invalidReason: nodeEnv === "production" ? "invalid_payload" : (e as Error).message,
  }
  return c.json(body, 400)
}

/**
 * Best-effort recovery of the request's `paymentRequirements.network` so error
 * responses can fill the `network` field correctly. Returns the unknown-network
 * sentinel only if we genuinely can't tell (malformed body that already failed
 * Zod parsing).
 */
async function recoverNetwork(c: Context): Promise<string> {
  try {
    // Hono caches the parsed body, so this won't re-read the stream when the
    // handler already consumed it. If parse failed, we get undefined and fall
    // through to the sentinel.
    const json = (await c.req.json().catch(() => undefined)) as
      | { paymentRequirements?: { network?: string } }
      | undefined
    const n = json?.paymentRequirements?.network
    if (typeof n === "string" && n.length > 0) return n
  } catch {
    // ignore — fall through
  }
  return "eip155:0"
}

async function errorToSettleResponse(c: Context, e: unknown, nodeEnv: AppDeps["nodeEnv"]) {
  const network = await recoverNetwork(c)
  if (e instanceof X402Error) {
    const body: SettlementResponse = {
      success: false,
      errorReason: e.code,
      transaction: "",
      network,
    }
    return c.json(body, asStatus(e.httpStatus))
  }
  const body: SettlementResponse = {
    success: false,
    errorReason: nodeEnv === "production" ? "invalid_payload" : (e as Error).message,
    transaction: "",
    network,
  }
  return c.json(body, 400)
}
