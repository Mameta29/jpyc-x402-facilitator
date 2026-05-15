/**
 * Normalise EIP-3009 `transferWithAuthorization` revert reasons into x402
 * error codes.
 *
 * viem surfaces a contract revert as a long `ContractFunctionExecutionError`
 * string ("The contract function ... reverted ... Contract Call ..."). The
 * useful part — the Solidity revert string — is buried inside and easily lost
 * if a caller slices the message. This maps the known FiatTokenV2 / JPYC
 * revert strings to the wire error codes so the HTTP layer can return a
 * meaningful `errorReason` instead of an opaque "tx broadcast failed".
 *
 * Mirrors the x402 reference facilitator's `parseEip3009TransferError`.
 */

import { X402_ERROR_CODES } from "@jpyc-x402/shared"

/**
 * Known revert-string fragments emitted by FiatTokenV2-style EIP-3009 tokens
 * (JPYC included), matched case-insensitively as substrings. Order matters
 * only in that the first match wins; the fragments are mutually exclusive in
 * practice.
 */
const REVERT_FRAGMENTS: ReadonlyArray<{ needle: string; code: string }> = [
  // EIP-3009: now >= validBefore
  { needle: "authorization is expired", code: X402_ERROR_CODES.invalid_exact_evm_payload_authorization_valid_before },
  // EIP-3009: now <= validAfter
  { needle: "authorization is not yet valid", code: X402_ERROR_CODES.invalid_exact_evm_payload_authorization_valid_after },
  // EIP-3009: _authorizationStates[authorizer][nonce] already true
  { needle: "authorization is used", code: X402_ERROR_CODES.invalid_transaction_state },
  { needle: "authorization is used or canceled", code: X402_ERROR_CODES.invalid_transaction_state },
  // ECDSA recover mismatch / malformed signature
  { needle: "invalid signature", code: X402_ERROR_CODES.invalid_exact_evm_payload_signature },
  // ERC-20 balance check inside transferWithAuthorization
  { needle: "transfer amount exceeds balance", code: X402_ERROR_CODES.insufficient_funds },
]

/**
 * Inspect a viem error (or any error/string) from a failed
 * `transferWithAuthorization` and return the matching x402 error code, or
 * `null` if the revert reason is not one we recognise.
 */
export function parseEip3009RevertReason(error: unknown): string | null {
  const haystack = extractErrorText(error).toLowerCase()
  if (!haystack) return null
  for (const { needle, code } of REVERT_FRAGMENTS) {
    if (haystack.includes(needle)) return code
  }
  return null
}

/**
 * Pull all available text out of an error: viem nests the real revert reason
 * in `cause`/`shortMessage`/`metaMessages`, so we walk those before falling
 * back to `message`.
 */
function extractErrorText(error: unknown): string {
  if (typeof error === "string") return error
  if (!error || typeof error !== "object") return String(error ?? "")

  const parts: string[] = []
  const seen = new Set<unknown>()
  let cursor: unknown = error
  // Bounded walk down the cause chain — viem nests at most a few levels.
  for (let depth = 0; depth < 8 && cursor && typeof cursor === "object"; depth++) {
    if (seen.has(cursor)) break
    seen.add(cursor)
    const e = cursor as Record<string, unknown>
    if (typeof e.shortMessage === "string") parts.push(e.shortMessage)
    if (typeof e.message === "string") parts.push(e.message)
    if (typeof e.details === "string") parts.push(e.details)
    if (typeof e.reason === "string") parts.push(e.reason)
    if (Array.isArray(e.metaMessages)) {
      parts.push(...e.metaMessages.filter((m): m is string => typeof m === "string"))
    }
    cursor = e.cause
  }
  return parts.join(" :: ")
}
