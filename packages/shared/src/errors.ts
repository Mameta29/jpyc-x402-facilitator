/**
 * x402 error code taxonomy.
 *
 * These strings are part of the wire format — they appear in
 * `SettlementResponse.errorReason` and `VerifyResponse.invalidReason`. The set
 * is taken verbatim from `x402-specification-v2.md §9`. We add a small number
 * of facilitator-internal codes prefixed with `facilitator_` for issues that
 * never travel back to the client over the wire (logged only).
 */

export const X402_ERROR_CODES = {
  insufficient_funds: "insufficient_funds",
  invalid_exact_evm_payload_authorization_valid_after:
    "invalid_exact_evm_payload_authorization_valid_after",
  invalid_exact_evm_payload_authorization_valid_before:
    "invalid_exact_evm_payload_authorization_valid_before",
  invalid_exact_evm_payload_authorization_value_mismatch:
    "invalid_exact_evm_payload_authorization_value_mismatch",
  invalid_exact_evm_payload_signature: "invalid_exact_evm_payload_signature",
  invalid_exact_evm_payload_recipient_mismatch: "invalid_exact_evm_payload_recipient_mismatch",
  invalid_network: "invalid_network",
  invalid_payload: "invalid_payload",
  invalid_payment_requirements: "invalid_payment_requirements",
  invalid_scheme: "invalid_scheme",
  unsupported_scheme: "unsupported_scheme",
  invalid_x402_version: "invalid_x402_version",
  invalid_transaction_state: "invalid_transaction_state",
  unexpected_verify_error: "unexpected_verify_error",
  unexpected_settle_error: "unexpected_settle_error",
} as const

export type X402ErrorCode = (typeof X402_ERROR_CODES)[keyof typeof X402_ERROR_CODES]

/** Facilitator-side codes that never leak into wire responses. */
export const FACILITATOR_INTERNAL_ERROR_CODES = {
  facilitator_insufficient_native_balance: "facilitator_insufficient_native_balance",
  facilitator_rate_limited: "facilitator_rate_limited",
  facilitator_replayed_nonce: "facilitator_replayed_nonce",
  facilitator_chain_unavailable: "facilitator_chain_unavailable",
} as const

export type FacilitatorInternalErrorCode =
  (typeof FACILITATOR_INTERNAL_ERROR_CODES)[keyof typeof FACILITATOR_INTERNAL_ERROR_CODES]

/**
 * Custom error subclass — gives the HTTP layer a single `instanceof` check to
 * map errors to the wire `errorReason` field while preserving the cause chain
 * for logs.
 */
export class X402Error extends Error {
  readonly code: X402ErrorCode | FacilitatorInternalErrorCode
  readonly httpStatus: number

  constructor(
    code: X402ErrorCode | FacilitatorInternalErrorCode,
    opts: { message?: string; httpStatus?: number; cause?: unknown } = {},
  ) {
    super(opts.message ?? code, opts.cause ? { cause: opts.cause } : undefined)
    this.name = "X402Error"
    this.code = code
    this.httpStatus = opts.httpStatus ?? defaultHttpStatusFor(code)
  }
}

function defaultHttpStatusFor(code: string): number {
  if (code === "insufficient_funds") return 402
  if (code.startsWith("invalid_") || code.startsWith("unsupported_")) return 400
  if (code === "facilitator_rate_limited") return 429
  if (code === "facilitator_chain_unavailable") return 503
  if (code.startsWith("unexpected_")) return 500
  return 400
}
