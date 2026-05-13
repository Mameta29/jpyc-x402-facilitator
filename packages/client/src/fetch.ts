/**
 * `fetchWithPayment` — the agent-side helper.
 *
 * Wraps a single HTTP request to a 402-aware resource server:
 *
 *   1. Try the request without payment.
 *   2. If 402 + PAYMENT-REQUIRED header arrives, decode it.
 *   3. Pick the first PaymentRequirements (or use a caller-supplied selector).
 *   4. Sign with the supplied signer.
 *   5. Replay the request with PAYMENT-SIGNATURE.
 *   6. Return the second response (or the first one, if it was already 200).
 *
 * The function is deliberately stateless. Callers that want budget controls
 * or wallet sessions wrap it themselves — that's the SIWx layer per x402 v2.
 */

import {
  decodeJsonBase64Url,
  paymentRequiredSchema,
  type PaymentRequired,
  type PaymentRequirements,
} from "@jpyc-x402/shared"
import {
  HEADER_PAYMENT_REQUIRED,
  HEADER_PAYMENT_RESPONSE,
  HEADER_PAYMENT_SIGNATURE,
} from "./headers.js"
import { encodeJsonBase64Url } from "@jpyc-x402/shared"
import { signPaymentPayload, type SignerLike } from "./sign.js"

export interface FetchWithPaymentOptions {
  signer: SignerLike
  /** Pick which `accepts[]` entry to pay. Defaults to the first. */
  selector?: (accepts: PaymentRequirements[]) => PaymentRequirements
  /** Override fetch (testing). */
  fetch?: typeof fetch
  /** Hooks for tracing / logging. */
  onPaymentRequired?: (required: PaymentRequired) => void
  onSettled?: (response: ReturnType<typeof JSON.parse>) => void
}

export async function fetchWithPayment(
  input: string | URL | Request,
  init: RequestInit | undefined,
  opts: FetchWithPaymentOptions,
): Promise<Response> {
  const fetchFn = opts.fetch ?? fetch
  const first = await fetchFn(input, init)
  if (first.status !== 402) return first

  const requiredHeader = first.headers.get(HEADER_PAYMENT_REQUIRED)
  if (!requiredHeader) {
    return first
  }
  const required = paymentRequiredSchema.parse(decodeJsonBase64Url(requiredHeader))
  opts.onPaymentRequired?.(required)

  const select = opts.selector ?? ((accepts) => accepts[0]!)
  const requirements = select(required.accepts)

  const payload = await signPaymentPayload({ signer: opts.signer, requirements })

  // Drain & forget the first body so its socket can return to the pool.
  await first.body?.cancel().catch(() => {})

  const headers = new Headers(init?.headers)
  headers.set(HEADER_PAYMENT_SIGNATURE, encodeJsonBase64Url(payload))
  const second = await fetchFn(input, { ...init, headers })

  const respHeader = second.headers.get(HEADER_PAYMENT_RESPONSE)
  if (respHeader && opts.onSettled) {
    try {
      opts.onSettled(decodeJsonBase64Url(respHeader))
    } catch {
      // ignore — the resource server didn't surface a parseable settle blob
    }
  }
  return second
}
