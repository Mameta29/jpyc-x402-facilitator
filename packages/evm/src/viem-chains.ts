/**
 * Map JPYC-supported chainIds to viem `Chain` definitions.
 *
 * All current chains are shipped by viem natively. viem still calls Kaia
 * Kairos by its old "klaytnBaobab" alias (chainId 1001) — both are the same
 * network.
 */

import { type Chain } from "viem"
import {
  avalanche,
  avalancheFuji,
  kaia,
  klaytnBaobab,
  mainnet,
  polygon,
  polygonAmoy,
  sepolia,
} from "viem/chains"
import { defineChain } from "viem"
import { getJpycChain } from "@jpyc-x402/shared"

const REGISTRY: Record<number, Chain> = {
  [mainnet.id]: mainnet,
  [polygon.id]: polygon,
  [avalanche.id]: avalanche,
  [kaia.id]: kaia,
  [sepolia.id]: sepolia,
  [polygonAmoy.id]: polygonAmoy,
  [avalancheFuji.id]: avalancheFuji,
  [klaytnBaobab.id]: klaytnBaobab,
}

export function resolveViemChain(chainId: number): Chain {
  const fromRegistry = REGISTRY[chainId]
  if (fromRegistry) return fromRegistry
  // Fallback: synthesise a chain from our internal registry. This keeps the
  // module tolerant if we add a chain to JPYC_CHAINS but forget to import it
  // from viem.
  const jpycChain = getJpycChain(chainId)
  return defineChain({
    id: jpycChain.chainId,
    name: jpycChain.name,
    nativeCurrency: { name: jpycChain.nativeSymbol, symbol: jpycChain.nativeSymbol, decimals: 18 },
    rpcUrls: { default: { http: [jpycChain.publicRpc] } },
    blockExplorers: { default: { name: "Explorer", url: jpycChain.explorer } },
    testnet: jpycChain.isTestnet,
  })
}
