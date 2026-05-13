/**
 * RPC client factory with multi-endpoint fallback.
 *
 * Operators configure endpoints per chain via env (e.g. `RPC_URLS_137`,
 * comma-separated). We use viem's `fallback` transport so a single dead RPC
 * doesn't break the facilitator. Each endpoint is hit with the same request;
 * failures cycle through the list until one succeeds. If none are configured
 * we fall back to the chain's `publicRpc` so local dev works out of the box,
 * but production deployments must always supply at least one private RPC —
 * public endpoints rate-limit aggressively.
 */

import {
  createPublicClient,
  createWalletClient,
  fallback,
  http,
  type Account,
  type PublicClient,
  type WalletClient,
} from "viem"
import { getJpycChain } from "@jpyc-x402/shared"
import { resolveViemChain } from "./viem-chains.js"

export interface ChainRpcConfig {
  /** Ordered list of RPC URLs. First is primary; rest are fallback. */
  urls: string[]
}

export type RpcResolver = (chainId: number) => ChainRpcConfig

/** Build a resolver that reads `RPC_URLS_<chainId>` from process.env. */
export function envRpcResolver(env: NodeJS.ProcessEnv = process.env): RpcResolver {
  return (chainId: number): ChainRpcConfig => {
    const raw = env[`RPC_URLS_${chainId}`]
    const urls = raw
      ? raw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : []
    if (urls.length === 0) {
      // dev convenience — fall back to the public RPC baked into the chain
      // registry. Production deployments will configure private RPCs.
      const chain = getJpycChain(chainId)
      urls.push(chain.publicRpc)
    }
    return { urls }
  }
}

/**
 * Build a viem `PublicClient` for a chain, with multi-endpoint fallback.
 *
 * `fallback` rotates through transports on RPC error; each transport gets a
 * conservative timeout so a hung RPC doesn't park a request indefinitely.
 */
export function buildPublicClient(chainId: number, resolver: RpcResolver): PublicClient {
  const { urls } = resolver(chainId)
  if (urls.length === 0) {
    throw new Error(`No RPC URL configured for chainId=${chainId}`)
  }
  return createPublicClient({
    chain: resolveViemChain(chainId),
    transport: fallback(
      urls.map((u) => http(u, { timeout: 15_000, retryCount: 0 })),
      { rank: false, retryCount: 1 },
    ),
  })
}

/** Build a viem `WalletClient` bound to the given relayer account. */
export function buildWalletClient(
  chainId: number,
  account: Account,
  resolver: RpcResolver,
): WalletClient {
  const { urls } = resolver(chainId)
  return createWalletClient({
    account,
    chain: resolveViemChain(chainId),
    transport: fallback(
      urls.map((u) => http(u, { timeout: 30_000, retryCount: 0 })),
      { rank: false, retryCount: 1 },
    ),
  })
}
