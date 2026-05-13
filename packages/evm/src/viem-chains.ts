/**
 * Map JPYC-supported chainIds to viem `Chain` definitions.
 *
 * For chains viem ships natively (Ethereum, Polygon, Avalanche, Sepolia,
 * Avalanche Fuji, Polygon Amoy) we import directly. For Kaia Kairos and
 * Arc testnet we synthesise minimal Chain shapes — viem only needs id /
 * name / native currency / rpcUrls / blockExplorers to function.
 */

import { defineChain, type Chain } from "viem"
import {
  avalanche,
  avalancheFuji,
  mainnet,
  polygon,
  polygonAmoy,
  sepolia,
} from "viem/chains"
import { getJpycChain } from "@jpyc-x402/shared"

const kairos = defineChain({
  id: 1001,
  name: "Kaia Kairos Testnet",
  nativeCurrency: { name: "KAIA", symbol: "KAIA", decimals: 18 },
  rpcUrls: { default: { http: ["https://public-en-kairos.node.kaia.io"] } },
  blockExplorers: { default: { name: "KaiaScan", url: "https://kairos.kaiascan.io" } },
  testnet: true,
})

const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 6 },
  rpcUrls: { default: { http: ["https://rpc.testnet.arc.network"] } },
  blockExplorers: { default: { name: "ArcScan", url: "https://testnet.arcscan.app" } },
  testnet: true,
})

const REGISTRY: Record<number, Chain> = {
  [mainnet.id]: mainnet,
  [polygon.id]: polygon,
  [avalanche.id]: avalanche,
  [sepolia.id]: sepolia,
  [polygonAmoy.id]: polygonAmoy,
  [avalancheFuji.id]: avalancheFuji,
  [kairos.id]: kairos,
  [arcTestnet.id]: arcTestnet,
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
