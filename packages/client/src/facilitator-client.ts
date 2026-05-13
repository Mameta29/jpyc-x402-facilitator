/**
 * Thin HTTP client for any x402 facilitator implementing
 * /verify, /settle, /supported (the spec-defined REST surface).
 *
 * The default base URL points at this project's hosted facilitator, but
 * callers should pass `baseUrl` explicitly for production use so swapping is
 * trivial. The client never assumes anything JPYC-specific — it should work
 * against the Coinbase CDP facilitator too.
 */

import {
  paymentRequirementsSchema,
  paymentPayloadSchema,
  settlementResponseSchema,
  supportedResponseSchema,
  verifyResponseSchema,
  X402_VERSION,
  type PaymentPayload,
  type PaymentRequirements,
  type SettlementResponse,
  type SupportedResponse,
  type VerifyResponse,
} from "@jpyc-x402/shared"

export interface FacilitatorClientOptions {
  baseUrl: string
  /** Override the global fetch — useful for tests and runtimes without a global fetch. */
  fetch?: typeof fetch
  /** Default per-request timeout in ms. */
  timeoutMs?: number
}

export class FacilitatorClient {
  private readonly baseUrl: string
  private readonly fetchFn: typeof fetch
  private readonly timeoutMs: number

  constructor(opts: FacilitatorClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "")
    this.fetchFn = opts.fetch ?? fetch
    this.timeoutMs = opts.timeoutMs ?? 20_000
  }

  async supported(): Promise<SupportedResponse> {
    const json = await this.get("/supported")
    return supportedResponseSchema.parse(json)
  }

  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    const json = await this.post("/verify", {
      x402Version: X402_VERSION,
      paymentPayload: paymentPayloadSchema.parse(payload),
      paymentRequirements: paymentRequirementsSchema.parse(requirements),
    })
    return verifyResponseSchema.parse(json)
  }

  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettlementResponse> {
    const json = await this.post("/settle", {
      x402Version: X402_VERSION,
      paymentPayload: paymentPayloadSchema.parse(payload),
      paymentRequirements: paymentRequirementsSchema.parse(requirements),
    })
    return settlementResponseSchema.parse(json)
  }

  private async get(path: string) {
    const url = `${this.baseUrl}${path}`
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs)
    try {
      const res = await this.fetchFn(url, { signal: ctrl.signal })
      return await readJson(res, path)
    } finally {
      clearTimeout(t)
    }
  }

  private async post(path: string, body: unknown) {
    const url = `${this.baseUrl}${path}`
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs)
    try {
      const res = await this.fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      })
      return await readJson(res, path)
    } finally {
      clearTimeout(t)
    }
  }
}

async function readJson(res: Response, path: string): Promise<unknown> {
  const text = await res.text()
  let json: unknown
  try {
    json = text ? JSON.parse(text) : {}
  } catch {
    throw new Error(`facilitator ${path} returned non-JSON body (status=${res.status}): ${text.slice(0, 200)}`)
  }
  if (!res.ok && res.status >= 500) {
    // 4xx are still parsed by the caller (verifyResponse / settlementResponse contain shapes for failure)
    throw new Error(`facilitator ${path} 5xx status=${res.status}: ${text.slice(0, 200)}`)
  }
  return json
}
