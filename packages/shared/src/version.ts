/**
 * x402 protocol version targeted by this codebase.
 * v2 is the current protocol version per the December 2025 release.
 *
 * v1 compatibility is intentionally not provided. New integrators should use
 * v2 from the start; the spec authors maintain SDK-level back-compat in the
 * reference `@x402/*` packages, but we don't carry that maintenance burden in
 * this JPYC-focused implementation.
 */
export const X402_VERSION = 2 as const
export type X402Version = typeof X402_VERSION

/**
 * Default validity window for a payment authorization (seconds).
 * x402 recommends short-lived authorizations to limit replay risk; the spec
 * uses 60s in examples and the reference Go v2 client uses 3600s. We pick
 * 300s: wide enough to absorb the gap between the client signing and the
 * facilitator broadcasting (402 round-trip + EIP-712 signing + per-chain
 * settle serialisation), without leaving an authorization replayable for an
 * hour. The settle path re-checks the window just before broadcast, so an
 * over-long value is bounded by that check rather than relied upon.
 */
export const DEFAULT_MAX_TIMEOUT_SECONDS = 300
