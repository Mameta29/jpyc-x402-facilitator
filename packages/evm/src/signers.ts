/**
 * Relayer signer abstraction.
 *
 * The facilitator needs an EVM `Account` per chain to sign and broadcast
 * settlement transactions. Today the only implementation reads a private key
 * from env (one shared key, with optional per-chain overrides). The
 * abstraction is intentional so we can swap to AWS KMS / GCP Cloud KMS
 * signers later without rewriting the call sites.
 */

import { type Account, type Hex } from "viem"
import { privateKeyToAccount } from "viem/accounts"

export interface RelayerSignerProvider {
  /** Return the signer for a given chainId; throw if not configured. */
  forChain(chainId: number): Account
  /** List chainIds for which a signer is configured. */
  supportedChainIds(): number[]
}

export interface PrivateKeyProviderOptions {
  /** Default key used when no per-chain override is configured. */
  defaultPrivateKey?: Hex
  /** Per-chain key overrides. */
  perChain?: Record<number, Hex>
}

/**
 * Read a relayer private key from env.
 *
 *  - `RELAYER_PRIVATE_KEY` provides the default
 *  - `RELAYER_PRIVATE_KEY_<chainId>` overrides per chain
 *
 * Keys are normalised to viem `Account` instances and cached.
 */
export function privateKeyRelayerProvider(
  opts: PrivateKeyProviderOptions = {},
): RelayerSignerProvider {
  const defaultAccount = opts.defaultPrivateKey
    ? privateKeyToAccount(opts.defaultPrivateKey)
    : undefined
  const cache = new Map<number, Account>()
  for (const [chainIdStr, key] of Object.entries(opts.perChain ?? {})) {
    cache.set(Number(chainIdStr), privateKeyToAccount(key))
  }
  return {
    forChain(chainId) {
      const cached = cache.get(chainId)
      if (cached) return cached
      if (defaultAccount) {
        cache.set(chainId, defaultAccount)
        return defaultAccount
      }
      throw new Error(`No relayer signer configured for chainId=${chainId}`)
    },
    supportedChainIds() {
      const ids = new Set<number>(cache.keys())
      // If we have a default, the set of supported chains is open — callers
      // ask `forChain(any)`. We expose the explicitly-overridden ones so the
      // /supported endpoint can declare a non-empty signers list.
      return [...ids]
    },
  }
}

/** Read default + per-chain keys from `process.env`. */
export function envPrivateKeyRelayerProvider(
  env: NodeJS.ProcessEnv = process.env,
): RelayerSignerProvider {
  const def = env.RELAYER_PRIVATE_KEY as Hex | undefined
  const perChain: Record<number, Hex> = {}
  for (const [k, v] of Object.entries(env)) {
    const m = k.match(/^RELAYER_PRIVATE_KEY_(\d+)$/)
    if (m && v) perChain[Number(m[1])] = v as Hex
  }
  return privateKeyRelayerProvider({ defaultPrivateKey: def, perChain })
}
