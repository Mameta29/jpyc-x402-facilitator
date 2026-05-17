/**
 * E2E: HMAC request auth + real settle on Avalanche Fuji, over real HTTP.
 *
 * This is the cross-repo interoperability check between:
 *
 *   - the facilitator's HMAC verifier   (packages/facilitator/src/auth.ts)
 *   - the EC platform's request signer  (jpyc-ec-platform .../x402/hmac-auth.ts)
 *
 * Rather than re-implementing the EC signer here, we import it directly from
 * the EC repo by path. The EC signer has no dependencies beyond Web Crypto, so
 * it loads cleanly. If the two wire formats ever drift, this test fails.
 *
 * What it does:
 *   1. Boots the real facilitator Hono app (HMAC auth enabled, Fuji only) on
 *      a real localhost HTTP server.
 *   2. Auth cases against GET /supported:
 *        - request signed by the EC signer with the shared key  -> 200
 *        - no Authorization header                              -> 401
 *        - tampered signature                                   -> 401
 *        - unknown keyId                                        -> 401
 *   3. Real settle: signs a 1-wei JPYC transferWithAuthorization, posts it to
 *      POST /settle WITH a valid EC-signed Authorization header, and confirms
 *      the on-chain Transfer event.
 *
 * Required env (skip the suite if any is missing):
 *   E2E_FUJI_PRIVATE_KEY  — funded with JPYC + native AVAX on Fuji
 *   E2E_SHOP_ADDRESS      — optional recipient; defaults to the signer address
 *   RPC_URLS_43113        — optional; falls back to public Fuji RPC
 */

import { fileURLToPath } from "node:url"
import type { AddressInfo } from "node:net"
import { serve } from "@hono/node-server"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  ExactEvmFacilitator,
  TRANSFER_EVENT_SIGNATURE,
  buildPublicClient,
  envRpcResolver,
  privateKeyRelayerProvider,
} from "@jpyc-x402/evm"
import {
  HmacAuthenticator,
  InProcessSettleRunner,
  NonceCache,
  RateLimiter,
  createApp,
} from "@jpyc-x402/facilitator"
import { signPaymentPayload } from "@jpyc-x402/client"
import { createPaymentRequirements } from "@jpyc-x402/shared"
import { privateKeyToAccount } from "viem/accounts"
import type { Address, Hex } from "viem"

// ── Import the EC platform's request signer directly, by path ─────────────
// This is the whole point of the test: prove the EC's signer interoperates
// with the facilitator's verifier. The EC repo is a sibling checkout of this
// one. hmac-auth.ts is plain TS with only Web Crypto deps, so vitest's loader
// transforms it on import like any local file.
//
// The signature is declared locally rather than via `typeof import(...)`:
// pulling the type from the EC file would force tsc to compile a file
// outside this package's rootDir. The shape is pinned here instead — if the
// EC signer's signature changes, this test stops compiling, which is the
// signal we want.
type SignFacilitatorRequest = (args: {
  key: { keyId: string; secret: string }
  method: string
  path: string
  body: Uint8Array
  now?: Date
}) => Promise<string>

const EC_HMAC_URL = new URL(
  "../../../jpyc-ec-platform/packages/shared/src/x402/hmac-auth.ts",
  import.meta.url,
)
const ecHmacModule = (await import(fileURLToPath(EC_HMAC_URL))) as {
  signFacilitatorRequest: SignFacilitatorRequest
}
const signFacilitatorRequest = ecHmacModule.signFacilitatorRequest

const CHAIN_ID = 43113
const SHARED_KEY = { keyId: "ec-staging", secret: "e2e-shared-hmac-secret" }

const fujiKey = process.env.E2E_FUJI_PRIVATE_KEY as Hex | undefined
const haveKey = Boolean(fujiKey)

describe.skipIf(!haveKey)("E2E: Fuji HMAC auth + real settle over HTTP", () => {
  let baseUrl: string
  let server: ReturnType<typeof serve>
  let buyer: ReturnType<typeof privateKeyToAccount>
  let shopAddress: Address

  beforeAll(async () => {
    buyer = privateKeyToAccount(fujiKey!)
    shopAddress = (process.env.E2E_SHOP_ADDRESS as Address) ?? buyer.address

    const facilitator = new ExactEvmFacilitator({
      enabledChainIds: [CHAIN_ID],
      rpcResolver: envRpcResolver(),
      // Same wallet pays gas — fine, EIP-3009 nonces are per (token, payer).
      signerProvider: privateKeyRelayerProvider({ defaultPrivateKey: fujiKey! }),
    })

    const app = createApp({
      facilitator,
      settleRunner: new InProcessSettleRunner(facilitator),
      rateLimiter: new RateLimiter({ windowSeconds: 60, maxRequests: 100 }),
      nonceCache: new NonceCache(300),
      cors: { origins: ["*"] },
      nodeEnv: "test",
      authenticator: new HmacAuthenticator({ keys: [SHARED_KEY] }),
    })

    server = serve({ fetch: app.fetch, port: 0 })
    const addr = server.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${addr.port}`
  })

  afterAll(() => {
    server?.close()
  })

  /** GET a path with an Authorization header built by the EC signer. */
  async function getSigned(
    path: string,
    opts: { key?: typeof SHARED_KEY; tamper?: boolean } = {},
  ): Promise<Response> {
    const header = await signFacilitatorRequest({
      key: opts.key ?? SHARED_KEY,
      method: "GET",
      path,
      body: new Uint8Array(0),
    })
    const authorization = opts.tamper
      ? header.replace(/sig=[0-9a-f]+/, "sig=" + "0".repeat(64))
      : header
    return fetch(`${baseUrl}${path}`, { headers: { authorization } })
  }

  it("accepts an EC-signed request on GET /supported (200)", async () => {
    const res = await getSigned("/supported")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { kinds: unknown[] }
    expect(Array.isArray(body.kinds)).toBe(true)
  })

  it("rejects a request with no Authorization header (401)", async () => {
    const res = await fetch(`${baseUrl}/supported`)
    expect(res.status).toBe(401)
  })

  it("rejects a tampered signature (401)", async () => {
    const res = await getSigned("/supported", { tamper: true })
    expect(res.status).toBe(401)
  })

  it("rejects an unknown keyId (401)", async () => {
    const res = await getSigned("/supported", {
      key: { keyId: "stranger", secret: "whatever" },
    })
    expect(res.status).toBe(401)
  })

  it("leaves GET /health public (no auth required)", async () => {
    const res = await fetch(`${baseUrl}/health`)
    expect(res.status).toBe(200)
  })

  it("settles 1 wei JPYC on Fuji via authenticated POST /settle", async () => {
    const requirements = createPaymentRequirements({
      chainId: CHAIN_ID,
      amountAtomic: "1",
      payTo: shopAddress,
      maxTimeoutSeconds: 120,
    })
    const payload = await signPaymentPayload({ signer: buyer, requirements })

    const body = JSON.stringify({
      x402Version: 2,
      paymentPayload: payload,
      paymentRequirements: requirements,
    })
    const authorization = await signFacilitatorRequest({
      key: SHARED_KEY,
      method: "POST",
      path: "/settle",
      body: new TextEncoder().encode(body),
    })

    const res = await fetch(`${baseUrl}/settle`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization },
      body,
    })
    expect(res.status).toBe(200)
    const settled = (await res.json()) as {
      success: boolean
      transaction: string
      errorReason?: string
    }
    expect(settled.errorReason).toBeUndefined()
    expect(settled.success).toBe(true)
    expect(settled.transaction).toMatch(/^0x[0-9a-f]{64}$/)

    // Confirm the Transfer event landed on-chain.
    const publicClient = buildPublicClient(CHAIN_ID, envRpcResolver())
    const receipt = await publicClient.getTransactionReceipt({
      hash: settled.transaction as Hex,
    })
    expect(receipt.status).toBe("success")
    const transferLog = receipt.logs.find(
      (log) =>
        log.topics[0] === TRANSFER_EVENT_SIGNATURE &&
        log.address.toLowerCase() === requirements.asset.toLowerCase(),
    )
    expect(transferLog).toBeDefined()
  })

  it("rejects an unauthenticated POST /settle before doing any work (401)", async () => {
    // Reuse a fresh requirements/payload; the request must die at the auth
    // middleware, never reaching rate limit / RPC / settle.
    const requirements = createPaymentRequirements({
      chainId: CHAIN_ID,
      amountAtomic: "1",
      payTo: shopAddress,
      maxTimeoutSeconds: 120,
    })
    const payload = await signPaymentPayload({ signer: buyer, requirements })
    const res = await fetch(`${baseUrl}/settle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        x402Version: 2,
        paymentPayload: payload,
        paymentRequirements: requirements,
      }),
    })
    expect(res.status).toBe(401)
  })
})
