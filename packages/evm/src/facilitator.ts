/**
 * High-level "ExactEvmFacilitator" — combines the verify + settle primitives
 * with chain-aware client provisioning.
 *
 * This is what the @jpyc-x402/facilitator HTTP package wraps; it's also the
 * intended import for anyone embedding facilitator logic in their own server.
 */

import {
  caip2ToEvmChainId,
  type PaymentPayload,
  type PaymentRequirements,
  type SupportedKind,
  X402_VERSION,
  evmChainIdToCaip2,
  listJpycChains,
} from "@jpyc-x402/shared"
import type { Account, Address, PublicClient } from "viem"
import { buildPublicClient, buildWalletClient, envRpcResolver, type RpcResolver } from "./rpc.js"
import { envPrivateKeyRelayerProvider, type RelayerSignerProvider } from "./signers.js"
import { verifyExactPayment, type VerifyResult } from "./verify.js"
import { settleExactPayment, type SettleResult } from "./settle.js"

export interface FacilitatorOptions {
  /** Which chains this facilitator advertises in /supported. */
  enabledChainIds: number[]
  /** Resolves RPC URLs per chain. Defaults to env-driven resolver. */
  rpcResolver?: RpcResolver
  /** Provides relayer signing accounts per chain. Defaults to env-driven. */
  signerProvider?: RelayerSignerProvider
}

export class ExactEvmFacilitator {
  private readonly enabledChainIds: ReadonlySet<number>
  private readonly rpcResolver: RpcResolver
  private readonly signerProvider: RelayerSignerProvider
  private readonly publicClientCache = new Map<number, PublicClient>()

  constructor(opts: FacilitatorOptions) {
    if (opts.enabledChainIds.length === 0) {
      throw new Error("ExactEvmFacilitator requires at least one enabled chainId")
    }
    this.enabledChainIds = new Set(opts.enabledChainIds)
    this.rpcResolver = opts.rpcResolver ?? envRpcResolver()
    this.signerProvider = opts.signerProvider ?? envPrivateKeyRelayerProvider()
  }

  isChainEnabled(chainId: number): boolean {
    return this.enabledChainIds.has(chainId)
  }

  /** Returned to clients via GET /supported. */
  supported(): SupportedKind[] {
    return [...this.enabledChainIds].map((chainId) => ({
      x402Version: X402_VERSION,
      scheme: "exact" as const,
      network: evmChainIdToCaip2(chainId),
    }))
  }

  /** Map of CAIP-2 wildcard → relayer signer addresses, for /supported.signers. */
  signers(): Record<string, Address[]> {
    const addresses: Address[] = []
    for (const chainId of this.enabledChainIds) {
      try {
        const acc = this.signerProvider.forChain(chainId)
        if (!addresses.some((a) => a.toLowerCase() === acc.address.toLowerCase())) {
          addresses.push(acc.address)
        }
      } catch (e) {
        // If a chain has no configured signer, skip it; /supported still
        // advertises the chain because verify (read-only) might still work.
        // We log because operators usually want to notice that a chain they
        // enabled has no relayer wallet — silent skip has bitten us in staging.
        console.warn(
          `[facilitator.signers] no relayer signer for chainId=${chainId}, ` +
            `omitted from /supported.signers — settle on this chain will fail. ` +
            `cause: ${e instanceof Error ? e.message : String(e)}`,
        )
      }
    }
    return { "eip155:*": addresses }
  }

  async verify(payload: PaymentPayload, required: PaymentRequirements): Promise<VerifyResult> {
    const chainId = caip2ToEvmChainId(required.network)
    if (!this.isChainEnabled(chainId)) {
      return { ok: false, reason: `invalid_network: chainId=${chainId} not enabled` }
    }
    const account = this.acquireAccount(chainId)
    const publicClient = this.acquirePublicClient(chainId)
    return verifyExactPayment(payload, required, { publicClient, relayerAccount: account })
  }

  async settle(
    payload: PaymentPayload,
    required: PaymentRequirements,
  ): Promise<{ verify: VerifyResult; settle?: SettleResult }> {
    const verifyResult = await this.verify(payload, required)
    if (!verifyResult.ok) return { verify: verifyResult }

    const chainId = verifyResult.chainId
    const account = this.acquireAccount(chainId)
    const publicClient = this.acquirePublicClient(chainId)
    const walletClient = buildWalletClient(chainId, account, this.rpcResolver)
    const settleResult = await settleExactPayment(
      verifyResult,
      payload.payload.signature as `0x${string}`,
      { publicClient, walletClient, relayerAccount: account },
    )
    return { verify: verifyResult, settle: settleResult }
  }

  private acquirePublicClient(chainId: number): PublicClient {
    const cached = this.publicClientCache.get(chainId)
    if (cached) return cached
    const client = buildPublicClient(chainId, this.rpcResolver)
    this.publicClientCache.set(chainId, client)
    return client
  }

  private acquireAccount(chainId: number): Account {
    return this.signerProvider.forChain(chainId)
  }
}

/**
 * Convenience: build a facilitator with all JPYC chains enabled, filtered by
 * the optional `ENABLED_NETWORKS` env (CAIP-2 comma list) and current
 * `NODE_ENV` (production keeps mainnets only).
 */
export function buildDefaultFacilitator(env: NodeJS.ProcessEnv = process.env): ExactEvmFacilitator {
  let candidates = listJpycChains().map((c) => c.chainId)
  if (env.NODE_ENV === "production") {
    candidates = listJpycChains({ mainnetOnly: true }).map((c) => c.chainId)
  } else if (env.NODE_ENV === "staging") {
    candidates = listJpycChains({ testnetOnly: true }).map((c) => c.chainId)
  }
  const explicit = (env.ENABLED_NETWORKS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  if (explicit.length > 0) {
    const explicitChainIds = new Set(explicit.map(caip2ToEvmChainId))
    candidates = candidates.filter((id) => explicitChainIds.has(id))
  }
  return new ExactEvmFacilitator({ enabledChainIds: candidates })
}
