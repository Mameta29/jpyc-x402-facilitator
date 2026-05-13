/**
 * Hono application exposing the x402 facilitator REST API.
 *
 * Routes:
 *   GET  /health     — liveness for the load balancer
 *   GET  /supported  — advertise scheme/network kinds we serve
 *   POST /verify     — verify a PaymentPayload against PaymentRequirements
 *   POST /settle     — verify + broadcast transferWithAuthorization
 *
 * Each route returns JSON in the schemas defined by `@jpyc-x402/shared`.
 * Errors are mapped to (HTTP status, errorReason) pairs by `errorToResponse`.
 *
 * The app is constructed via `createApp(deps)` so tests can swap in a fake
 * facilitator + in-memory rate limiter; production wiring lives in apps/server.
 */

import { Hono, type Context } from "hono"
import { cors } from "hono/cors"
import { logger as honoLogger } from "hono/logger"
import {
  X402Error,
  evmChainIdToCaip2,
  settleRequestSchema,
  verifyRequestSchema,
  X402_VERSION,
  type SettlementResponse,
  type SupportedResponse,
  type VerifyResponse,
} from "@jpyc-x402/shared"
import type { ExactEvmFacilitator } from "@jpyc-x402/evm"
import type { Address } from "viem"
import { eq, and } from "drizzle-orm"
import type { Database } from "./db/index.js"
import { settlements } from "./db/index.js"
import { RateLimiter } from "./rate-limit.js"
import type { BalanceMonitor } from "./balance-monitor.js"

export interface AppDeps {
  facilitator: ExactEvmFacilitator
  db: Database
  rateLimiter: RateLimiter
  balanceMonitor?: BalanceMonitor
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
      return c.json(response, result.ok ? 200 : 200)
    } catch (e) {
      return errorToVerifyResponse(c, e, deps.nodeEnv)
    }
  })

  app.post("/settle", async (c) => {
    try {
      const json = await c.req.json()
      const parsed = settleRequestSchema.parse(json)

      // Pre-rate-limit before doing any RPC work.
      const payer = parsed.paymentPayload.payload.authorization.from as Address
      const valueAtomic = BigInt(parsed.paymentPayload.payload.authorization.value)
      await deps.rateLimiter.consume(payer, valueAtomic)

      // Replay-protect ourselves: refuse to broadcast a (chainId, payer, nonce)
      // we've already settled. Idempotency by row.
      const chainIdGuess = chainIdFromCaip2(parsed.paymentRequirements.network)
      const nonce = parsed.paymentPayload.payload.authorization.nonce
      const existing = await deps.db
        .select()
        .from(settlements)
        .where(
          and(
            eq(settlements.chainId, chainIdGuess),
            eq(settlements.payer, payer.toLowerCase()),
            eq(settlements.nonce, nonce),
          ),
        )
        .limit(1)
      const dup = existing[0]
      if (dup && dup.status === "settled") {
        const body: SettlementResponse = {
          success: true,
          payer,
          transaction: dup.txHash ?? "",
          network: parsed.paymentRequirements.network,
          amount: dup.valueAtomic.toString(),
        }
        return c.json(body)
      }

      const refuseForBalance = deps.balanceMonitor
        ? await deps.balanceMonitor.isCritical(chainIdGuess)
        : false
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

      // Insert audit row up-front so we can correlate failure with a request.
      const [audit] = await deps.db
        .insert(settlements)
        .values({
          chainId: chainIdGuess,
          asset: parsed.paymentRequirements.asset.toLowerCase(),
          payer: payer.toLowerCase(),
          payTo: parsed.paymentRequirements.payTo.toLowerCase(),
          valueAtomic: valueAtomic.toString(),
          nonce,
          validAfter: BigInt(parsed.paymentPayload.payload.authorization.validAfter),
          validBefore: BigInt(parsed.paymentPayload.payload.authorization.validBefore),
          signature: parsed.paymentPayload.payload.signature,
          status: "verified",
        })
        .returning()

      const result = await deps.facilitator.settle(
        parsed.paymentPayload,
        parsed.paymentRequirements,
      )

      if (!result.verify.ok) {
        await deps.db
          .update(settlements)
          .set({ status: "failed", errorReason: result.verify.reason })
          .where(eq(settlements.id, audit!.id))
        const body: SettlementResponse = {
          success: false,
          errorReason: shortReason(result.verify.reason),
          payer: result.verify.payer ?? payer,
          transaction: "",
          network: parsed.paymentRequirements.network,
        }
        return c.json(body, 200)
      }

      const settle = result.settle!
      if (!settle.ok) {
        await deps.db
          .update(settlements)
          .set({
            status: "failed",
            errorReason: settle.reason,
            ...(settle.txHash ? { txHash: settle.txHash } : {}),
          })
          .where(eq(settlements.id, audit!.id))
        const body: SettlementResponse = {
          success: false,
          errorReason: shortReason(settle.reason),
          payer,
          transaction: settle.txHash ?? "",
          network: parsed.paymentRequirements.network,
        }
        return c.json(body, 200)
      }

      await deps.db
        .update(settlements)
        .set({
          status: "settled",
          txHash: settle.txHash,
          blockNumber: settle.blockNumber,
          gasUsed: settle.gasUsed.toString(),
          effectiveGasPrice: settle.effectiveGasPrice.toString(),
          gasCostNative: settle.gasCostNative,
          settledAt: new Date(),
        })
        .where(eq(settlements.id, audit!.id))

      const body: SettlementResponse = {
        success: true,
        payer,
        transaction: settle.txHash,
        network: parsed.paymentRequirements.network,
        amount: valueAtomic.toString(),
      }
      return c.json(body)
    } catch (e) {
      return errorToSettleResponse(c, e, deps.nodeEnv)
    }
  })

  // Convenience meta-endpoint for callers that want server build info.
  app.get("/", (c) =>
    c.json({
      name: "jpyc-x402-facilitator",
      x402Version: X402_VERSION,
      enabledNetworks: deps.facilitator.supported().map((k) => k.network),
    }),
  )

  return app
}

function chainIdFromCaip2(caip2: string): number {
  const ref = caip2.split(":")[1]
  if (!ref) throw new Error(`malformed CAIP-2: ${caip2}`)
  return Number(ref)
}

function shortReason(reason: string): string {
  // Surface only the spec error code if the message starts with one.
  const colon = reason.indexOf(":")
  if (colon > 0 && colon < 80) return reason.slice(0, colon)
  return reason
}

type ContentfulStatus = 200 | 400 | 402 | 429 | 500 | 503
function asStatus(n: number): ContentfulStatus {
  // Map known facilitator statuses to the literal union Hono expects.
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

function errorToSettleResponse(c: Context, e: unknown, nodeEnv: AppDeps["nodeEnv"]) {
  if (e instanceof X402Error) {
    const body: SettlementResponse = {
      success: false,
      errorReason: e.code,
      transaction: "",
      network: "eip155:0",
    }
    return c.json(body, asStatus(e.httpStatus))
  }
  const body: SettlementResponse = {
    success: false,
    errorReason: nodeEnv === "production" ? "invalid_payload" : (e as Error).message,
    transaction: "",
    network: "eip155:0",
  }
  return c.json(body, 400)
}

export { settlements as _settlementsTable }
