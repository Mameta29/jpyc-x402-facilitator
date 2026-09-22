/**
 * Map JPYC-supported chainIds to viem `Chain` definitions.
 *
 * All current chains are shipped by viem natively. viem still calls Kaia
 * Kairos by its old "klaytnBaobab" alias (chainId 1001) — both are the same
 * network.
 */

import { type Chain } from "viem"
import { estimateMaxPriorityFeePerGas } from "viem/actions"
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

// Some Ethereum RPCs return a zero tip. A short-lived payment authorization
// must not wait behind tipped transactions until it expires. Keep the live
// estimate when higher; apply the same floor on Sepolia for release testing.
const MIN_ETHEREUM_PRIORITY_FEE = 100_000_000n // 0.1 gwei; paid by the relayer.
function ethereumPaymentChain(chain: Chain): Chain {
  return {
    ...chain,
    fees: {
      ...chain.fees,
      baseFeeMultiplier: 2,
      maxPriorityFeePerGas: async ({ client }) => {
        // Explicitly pass the original chain to avoid recursing into this hook.
        const estimated = await estimateMaxPriorityFeePerGas(client, { chain })
        return estimated > MIN_ETHEREUM_PRIORITY_FEE ? estimated : MIN_ETHEREUM_PRIORITY_FEE
      },
    },
  }
}

const REGISTRY: Record<number, Chain> = {
  [mainnet.id]: ethereumPaymentChain(mainnet),
  [polygon.id]: polygon,
  [avalanche.id]: avalanche,
  [kaia.id]: kaia,
  [sepolia.id]: ethereumPaymentChain(sepolia),
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
