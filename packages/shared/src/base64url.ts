/**
 * base64url JSON helpers for x402 HTTP transport headers.
 *
 * x402 v2 sends `PaymentRequired`, `PaymentPayload`, and `SettlementResponse`
 * as base64-encoded JSON in HTTP headers (`PAYMENT-REQUIRED`,
 * `PAYMENT-SIGNATURE`, `PAYMENT-RESPONSE`). The spec uses standard base64
 * but we use base64url internally because:
 *
 *   1. Header values must be ASCII; '+' / '/' / '=' are technically allowed
 *      but trip up some proxies and CDNs.
 *   2. The reference Coinbase SDK accepts both forms when decoding.
 *
 * Decoding accepts both base64 and base64url so we are interoperable with the
 * spec-literal form while emitting the safer one.
 */

/** Encode an arbitrary JSON-serialisable value as base64url. */
export function encodeJsonBase64Url(value: unknown): string {
  const json = JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v))
  const buf = Buffer.from(json, "utf8")
  return buf.toString("base64url")
}

/** Decode a header value that may be base64 OR base64url. */
export function decodeJsonBase64Url<T = unknown>(input: string): T {
  // base64url uses '-' '_' instead of '+' '/' and omits padding;
  // accept both by normalising to standard base64 first.
  const normalised = input.replace(/-/g, "+").replace(/_/g, "/")
  const padding = normalised.length % 4 === 0 ? "" : "=".repeat(4 - (normalised.length % 4))
  const buf = Buffer.from(normalised + padding, "base64")
  const json = buf.toString("utf8")
  return JSON.parse(json) as T
}

/** True if the input looks like a valid base64/base64url string of non-zero length. */
export function looksLikeBase64Header(input: string): boolean {
  return /^[A-Za-z0-9+/_-]+={0,2}$/.test(input) && input.length > 0
}
