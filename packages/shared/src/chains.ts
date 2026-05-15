/**
 * JPYC chain registry.
 *
 * The same JPYC contract address (`0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29`)
 * is used across every supported chain — this is an explicit operational
 * decision by the JPYC EC platform team, mirrored in
 * `jpyc-ec-platform/packages/shared/src/config/chains.ts`. We treat that
 * address as authoritative until JPYC publishes per-chain deployments.
 *
 * Domain `name` ("JPY Coin") and `version` ("1") follow the JPYC v2 token's
 * EIP-712 domain — confirmed against the Polygonscan implementation contract
 * `0x431d5dff03120afa4bdf332c61a6e1766ef37bdb`.
 */

import { evmChainIdToCaip2 } from "./caip2.js"

export interface JpycChain {
  /** Numeric EVM chainId. */
  chainId: number
  /** CAIP-2 identifier (memoised in the registry — do not recompute). */
  caip2: string
  /** Human name for logs and UI. */
  name: string
  /** Short label for compact UIs. */
  shortName: string
  /** Mainnet vs testnet — used by env filters. */
  isTestnet: boolean
  /** JPYC contract address on this chain (lowercase canonicalised at lookup). */
  jpycAddress: `0x${string}`
  /** EIP-712 domain `name` — must match the on-chain contract. */
  jpycDomainName: string
  /** EIP-712 domain `version` — must match the on-chain contract. */
  jpycDomainVersion: string
  /** Native gas token symbol (POL/ETH/AVAX/KAIA/USDC). */
  nativeSymbol: string
  /** Block explorer base URL. */
  explorer: string
  /** Default public RPC, used when no env-supplied RPC is configured. */
  publicRpc: string
}

const JPYC_ADDRESS: `0x${string}` = "0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29"
const DOMAIN_NAME = "JPY Coin"
const DOMAIN_VERSION = "1"

/**
 * Source-of-truth registry. Order is the canonical display order
 * (mainnets first, then testnets in the same chain family order).
 */
export const JPYC_CHAINS: readonly JpycChain[] = [
  // Mainnets
  {
    chainId: 1,
    caip2: evmChainIdToCaip2(1),
    name: "Ethereum Mainnet",
    shortName: "Ethereum",
    isTestnet: false,
    jpycAddress: JPYC_ADDRESS,
    jpycDomainName: DOMAIN_NAME,
    jpycDomainVersion: DOMAIN_VERSION,
    nativeSymbol: "ETH",
    explorer: "https://etherscan.io",
    publicRpc: "https://ethereum-rpc.publicnode.com",
  },
  {
    chainId: 137,
    caip2: evmChainIdToCaip2(137),
    name: "Polygon Mainnet",
    shortName: "Polygon",
    isTestnet: false,
    jpycAddress: JPYC_ADDRESS,
    jpycDomainName: DOMAIN_NAME,
    jpycDomainVersion: DOMAIN_VERSION,
    nativeSymbol: "POL",
    explorer: "https://polygonscan.com",
    publicRpc: "https://polygon-rpc.com",
  },
  {
    chainId: 43114,
    caip2: evmChainIdToCaip2(43114),
    name: "Avalanche Mainnet",
    shortName: "Avalanche",
    isTestnet: false,
    jpycAddress: JPYC_ADDRESS,
    jpycDomainName: DOMAIN_NAME,
    jpycDomainVersion: DOMAIN_VERSION,
    nativeSymbol: "AVAX",
    explorer: "https://snowtrace.io",
    publicRpc: "https://api.avax.network/ext/bc/C/rpc",
  },
  {
    chainId: 8217,
    caip2: evmChainIdToCaip2(8217),
    name: "Kaia Mainnet",
    shortName: "Kaia",
    isTestnet: false,
    jpycAddress: JPYC_ADDRESS,
    jpycDomainName: DOMAIN_NAME,
    jpycDomainVersion: DOMAIN_VERSION,
    nativeSymbol: "KAIA",
    explorer: "https://kaiascan.io",
    publicRpc: "https://public-en.node.kaia.io",
  },
  // Testnets
  {
    chainId: 11155111,
    caip2: evmChainIdToCaip2(11155111),
    name: "Sepolia Testnet",
    shortName: "Sepolia",
    isTestnet: true,
    jpycAddress: JPYC_ADDRESS,
    jpycDomainName: DOMAIN_NAME,
    jpycDomainVersion: DOMAIN_VERSION,
    nativeSymbol: "ETH",
    explorer: "https://sepolia.etherscan.io",
    publicRpc: "https://ethereum-sepolia-rpc.publicnode.com",
  },
  {
    chainId: 80002,
    caip2: evmChainIdToCaip2(80002),
    name: "Polygon Amoy Testnet",
    shortName: "Amoy",
    isTestnet: true,
    jpycAddress: JPYC_ADDRESS,
    jpycDomainName: DOMAIN_NAME,
    jpycDomainVersion: DOMAIN_VERSION,
    nativeSymbol: "POL",
    explorer: "https://amoy.polygonscan.com",
    publicRpc: "https://rpc-amoy.polygon.technology",
  },
  {
    chainId: 43113,
    caip2: evmChainIdToCaip2(43113),
    name: "Avalanche Fuji Testnet",
    shortName: "Fuji",
    isTestnet: true,
    jpycAddress: JPYC_ADDRESS,
    jpycDomainName: DOMAIN_NAME,
    jpycDomainVersion: DOMAIN_VERSION,
    nativeSymbol: "AVAX",
    explorer: "https://testnet.snowtrace.io",
    publicRpc: "https://api.avax-test.network/ext/bc/C/rpc",
  },
  {
    chainId: 1001,
    caip2: evmChainIdToCaip2(1001),
    name: "Kaia Kairos Testnet",
    shortName: "Kairos",
    isTestnet: true,
    jpycAddress: JPYC_ADDRESS,
    jpycDomainName: DOMAIN_NAME,
    jpycDomainVersion: DOMAIN_VERSION,
    nativeSymbol: "KAIA",
    explorer: "https://kairos.kaiascan.io",
    publicRpc: "https://public-en-kairos.node.kaia.io",
  },
] as const

/** O(1) lookup index by chainId. */
const BY_CHAIN_ID: ReadonlyMap<number, JpycChain> = new Map(
  JPYC_CHAINS.map((c) => [c.chainId, c]),
)

/** O(1) lookup index by CAIP-2 string. */
const BY_CAIP2: ReadonlyMap<string, JpycChain> = new Map(JPYC_CHAINS.map((c) => [c.caip2, c]))

export function getJpycChain(idOrCaip2: number | string): JpycChain {
  const chain =
    typeof idOrCaip2 === "number" ? BY_CHAIN_ID.get(idOrCaip2) : BY_CAIP2.get(idOrCaip2)
  if (!chain) {
    throw new Error(`Unsupported JPYC chain: ${String(idOrCaip2)}`)
  }
  return chain
}

export function tryGetJpycChain(idOrCaip2: number | string): JpycChain | undefined {
  return typeof idOrCaip2 === "number" ? BY_CHAIN_ID.get(idOrCaip2) : BY_CAIP2.get(idOrCaip2)
}

export function listJpycChains(filter?: { mainnetOnly?: boolean; testnetOnly?: boolean }) {
  if (filter?.mainnetOnly) return JPYC_CHAINS.filter((c) => !c.isTestnet)
  if (filter?.testnetOnly) return JPYC_CHAINS.filter((c) => c.isTestnet)
  return [...JPYC_CHAINS]
}

/** JPYC has 18 decimals on every supported chain. */
export const JPYC_DECIMALS = 18 as const
