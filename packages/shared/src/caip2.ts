/**
 * CAIP-2 helpers (https://chainagnostic.org/CAIPs/caip-2).
 *
 * x402 v2 identifies networks as `<namespace>:<reference>`, e.g. `eip155:137`.
 * Internally most code wants a numeric chainId. These helpers move between
 * the two without losing the namespace information that becomes important
 * once non-EVM chains (Solana, Stellar, …) join the picture.
 */

export type Caip2Namespace = "eip155" | "solana" | "stellar" | "aptos" | "sui" | string

export interface Caip2 {
  namespace: Caip2Namespace
  reference: string
}

const CAIP2_REGEX = /^([-a-z0-9]{3,8}):([-_a-zA-Z0-9]{1,32})$/

export function parseCaip2(input: string): Caip2 {
  const match = CAIP2_REGEX.exec(input)
  if (!match) {
    throw new Error(`Invalid CAIP-2 identifier: ${input}`)
  }
  return { namespace: match[1] as Caip2Namespace, reference: match[2]! }
}

export function isCaip2(input: string): boolean {
  return CAIP2_REGEX.test(input)
}

/** Stringify a Caip2 back to canonical form. */
export function formatCaip2(c: Caip2): string {
  return `${c.namespace}:${c.reference}`
}

/**
 * Convert an EVM CAIP-2 (eip155:N) to a numeric chainId. Throws for non-EVM.
 *
 * We accept the numeric form too (e.g. `"137"`) for ergonomics in places like
 * config loading, but reject anything ambiguous to avoid silent mistakes.
 */
export function caip2ToEvmChainId(input: string | number): number {
  if (typeof input === "number") return input
  if (/^\d+$/.test(input)) return Number(input)
  const parsed = parseCaip2(input)
  if (parsed.namespace !== "eip155") {
    throw new Error(`Not an EVM CAIP-2 id: ${input} (namespace=${parsed.namespace})`)
  }
  if (!/^\d+$/.test(parsed.reference)) {
    throw new Error(`Invalid eip155 reference (expected number): ${input}`)
  }
  const id = Number(parsed.reference)
  if (!Number.isFinite(id) || id <= 0) {
    throw new Error(`Out-of-range chainId: ${id}`)
  }
  return id
}

/** Build a CAIP-2 string for an EVM chainId. */
export function evmChainIdToCaip2(chainId: number): string {
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new Error(`Invalid EVM chainId: ${chainId}`)
  }
  return `eip155:${chainId}`
}
