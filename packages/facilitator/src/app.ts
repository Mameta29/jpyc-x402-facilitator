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
  FACILITATOR_INTERNAL_ERROR_CODES,
  caip2ToEvmChainId,
  settleRequestSchema,
  verifyRequestSchema,
  X402_VERSION,
  type DiscoveryResource,
  type DiscoveryResourcesResponse,
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
import { HmacAuthenticator } from "./auth.js"

export interface AppDeps {
  facilitator: ExactEvmFacilitator
  settleRunner: SettleRunner
  rateLimiter: RateLimiter
  nonceCache: NonceCache
  balanceCache?: BalanceCache
  cors: { origins: string[] }
  /** Node env, used to gate verbose error responses. */
  nodeEnv: "development" | "staging" | "production" | "test"
  /**
   * HMAC request authenticator guarding /verify, /settle and /supported.
   * When omitted (or constructed with no keys) those endpoints run
   * unauthenticated — loadConfig only permits that in development/test.
   */
  authenticator?: HmacAuthenticator
  /**
   * Static x402 Bazaar discovery catalog. Lists the x402-payable resources
   * this facilitator fronts (e.g. the JPYC EC checkout). The host builds it
   * from configuration — this facilitator is DB-free, so the catalog is
   * static rather than populated from observed settlements. Omitted/empty
   * means GET /discovery/resources returns an empty catalog.
   */
  discovery?: { resources: DiscoveryResource[] }
  /**
   * Persistent broadcast-record lookup backing POST /settle-status. In the
   * Workers host this reads the per-chain RelayerSignerDO's storage; the Node
   * host may omit it (the endpoint then answers from the in-memory NonceCache
   * only). Lets a caller whose /settle call timed out ask "was this
   * authorization broadcast, and with which tx?" instead of blindly retrying.
   */
  settleRecords?: {
    get(
      chainId: number,
      payer: string,
      nonce: string,
    ): Promise<{ txHash: string; broadcastAt: number } | null>
  }
}

export function createApp(deps: AppDeps) {
  const app = new Hono()

  app.use("*", honoLogger())
  app.use(
    "*",
    cors({
      origin: deps.cors.origins.includes("*") ? "*" : deps.cors.origins,
      allowHeaders: ["Content-Type", "PAYMENT-SIGNATURE", "Authorization"],
      exposeHeaders: ["PAYMENT-REQUIRED", "PAYMENT-RESPONSE"],
    }),
  )

  // HMAC request auth for the mutating + advertising endpoints. /health, /
  // and /discovery/resources stay public: the first two carry no payload and
  // the discovery catalog is meant to be crawled by x402 Bazaar agents.
  //
  // The middleware buffers the raw body once via c.req.arrayBuffer(); Hono
  // caches it, so the downstream handler's c.req.json() reuses the same bytes
  // without re-reading the stream.
  const authMiddleware = async (c: Context, next: () => Promise<void>) => {
    const auth = deps.authenticator
    if (!auth || !auth.hasKeys) {
      // No keys configured — loadConfig only allows this in development/test.
      // Log once per request so an accidentally-open deploy is visible.
      console.warn(
        JSON.stringify({ ev: "auth.disabled", path: c.req.path, method: c.req.method }),
      )
      await next()
      return
    }

    const url = new URL(c.req.url)
    const body =
      c.req.method === "GET" || c.req.method === "HEAD"
        ? new Uint8Array(0)
        : new Uint8Array(await c.req.arrayBuffer())

    const result = await auth.authenticate({
      method: c.req.method,
      path: url.pathname,
      authorizationHeader: c.req.header("authorization"),
      body,
    })
    if (!result.ok) {
      // `detail` is the operator-facing diagnosis (never sent to the client).
      // `bodyLen` is logged on a signature mismatch so a body-encoding drift
      // between signer and verifier is visible — it's the most common cause.
      console.warn(
        JSON.stringify({
          ev: "auth.rejected",
          path: url.pathname,
          method: c.req.method,
          detail: result.detail,
          bodyLen: body.byteLength,
        }),
      )
      return c.json({ error: "unauthorized" }, result.status)
    }
    await next()
  }
  app.use("/verify", authMiddleware)
  app.use("/settle", authMiddleware)
  app.use("/settle-status", authMiddleware)
  app.use("/supported", authMiddleware)

  app.get("/health", (c) => c.json({ ok: true }))

  app.get("/supported", (c) => {
    const body: SupportedResponse = {
      kinds: deps.facilitator.supported(),
      // "bazaar" advertises that this facilitator exposes the discovery
      // layer at GET /discovery/resources.
      extensions: deps.discovery ? ["bazaar"] : [],
      signers: deps.facilitator.signers(),
    }
    return c.json(body)
  })

  // x402 Bazaar discovery layer — lets agents and clients enumerate the
  // x402-payable resources this facilitator fronts. Catalog is static
  // (config-driven) since the facilitator is DB-free.
  app.get("/discovery/resources", (c) => {
    const all = deps.discovery?.resources ?? []
    const rawLimit = Number(c.req.query("limit") ?? "100")
    const rawOffset = Number(c.req.query("offset") ?? "0")
    const limit = Number.isFinite(rawLimit)
      ? Math.min(1000, Math.max(1, Math.trunc(rawLimit)))
      : 100
    const offset = Number.isFinite(rawOffset)
      ? Math.max(0, Math.trunc(rawOffset))
      : 0

    const body: DiscoveryResourcesResponse = {
      x402Version: X402_VERSION,
      items: all.slice(offset, offset + limit),
      pagination: { limit, offset, total: all.length },
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
            invalidReason: verifyFailureCode(result.reason),
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

      const chainId = caip2ToEvmChainId(parsed.paymentRequirements.network)
      const nonce = parsed.paymentPayload.payload.authorization.nonce

      // 1) Nonce cache — if we already settled this exact triple within the
      //    cache window, return the cached tx hash without re-broadcasting.
      //    Truth is on-chain (`_authorizationStates`); this just saves gas
      //    and a round-trip when callers retry.
      //
      //    Checked BEFORE the rate limiter on purpose: an idempotent replay
      //    performs zero on-chain work, so it must not consume rate-limit
      //    budget — otherwise a legitimately retrying payer can lock
      //    themselves out of their own next payment (audit Med-4).
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

      // 2) Rate limit before any RPC work.
      deps.rateLimiter.consume(payer, valueAtomic)

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
          errorReason: verifyFailureCode(result.verify.reason),
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

  // Broadcast-record lookup for callers whose /settle call timed out or got
  // an ambiguous failure. Body: { network, payer, nonce } (POST so the HMAC
  // signature covers the parameters — GET query strings are not signed).
  //
  // Response: { known: true, txHash, broadcastAt } when a broadcast record
  // (DO storage, 72h retention) or a cached settle (NonceCache) exists;
  // { known: false } otherwise. IMPORTANT: known:false is NOT proof that no
  // funds moved — records expire, and a tx may exist from before this
  // feature deployed. The contract's `authorizationState` remains the
  // authoritative source; this endpoint's value is returning the txHash,
  // which authorizationState cannot.
  app.post("/settle-status", async (c) => {
    try {
      const json = (await c.req.json()) as {
        network?: unknown
        payer?: unknown
        nonce?: unknown
      }
      const network = typeof json.network === "string" ? json.network : ""
      const payer = typeof json.payer === "string" ? json.payer : ""
      const nonce = typeof json.nonce === "string" ? json.nonce : ""
      if (
        !/^0x[0-9a-fA-F]{40}$/.test(payer) ||
        !/^0x[0-9a-fA-F]{64}$/.test(nonce)
      ) {
        return c.json({ error: "invalid payer or nonce" }, 400)
      }
      const chainId = caip2ToEvmChainId(network)

      const cached = deps.nonceCache.get(chainId, payer as Address, nonce)
      if (cached?.settled && cached.txHash) {
        return c.json({ known: true, txHash: cached.txHash, source: "cache" })
      }
      const record = (await deps.settleRecords?.get(chainId, payer, nonce)) ?? null
      if (record) {
        return c.json({
          known: true,
          txHash: record.txHash,
          broadcastAt: record.broadcastAt,
          source: "durable",
        })
      }
      return c.json({ known: false })
    } catch (e) {
      if (e instanceof X402Error) {
        return c.json({ error: e.code }, asStatus(e.httpStatus))
      }
      return c.json({ error: "invalid request" }, 400)
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

/**
 * Map a verify-failure reason to its wire code.
 *
 * "nonce already used" gets its own code (`authorization_already_used`)
 * instead of collapsing into `invalid_exact_evm_payload_signature`: the two
 * are opposites for the caller. A bad signature means no funds ever moved;
 * a consumed nonce means funds ALREADY moved (this settle, or an earlier one
 * whose response was lost). Callers that restore reservations / re-prompt
 * signatures on "signature invalid" must never do so on "already used".
 */
export function verifyFailureCode(reason: string): string {
  if (reason.includes("nonce already used")) {
    return FACILITATOR_INTERNAL_ERROR_CODES.authorization_already_used
  }
  return shortReason(reason)
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
