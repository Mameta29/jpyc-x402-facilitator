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
 * uses 60s in examples. We default a touch wider to absorb agent network
 * latency on slow links.
 */
export const DEFAULT_MAX_TIMEOUT_SECONDS = 90
