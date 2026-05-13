/**
 * Header constants used by the x402 v2 HTTP transport.
 *
 * Per the spec these are case-insensitive in HTTP, but we use the canonical
 * upper-snake form in code for searchability.
 */

export const HEADER_PAYMENT_REQUIRED = "PAYMENT-REQUIRED"
export const HEADER_PAYMENT_SIGNATURE = "PAYMENT-SIGNATURE"
export const HEADER_PAYMENT_RESPONSE = "PAYMENT-RESPONSE"
