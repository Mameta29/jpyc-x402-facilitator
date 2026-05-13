/**
 * Convenience builders for resource servers.
 *
 * Resource servers care about "what amount, what chain, what merchant" — not
 * about CAIP-2 strings, EIP-712 domains, or atomic-unit fiddling. These
 * builders take ergonomic input, validate it, and emit a fully-shaped
 * `PaymentRequirements` / `PaymentRequired` ready for the wire.
 */

import type { Address } from "viem"
import { evmChainIdToCaip2 } from "./caip2.js"
import { JPYC_DECIMALS, getJpycChain } from "./chains.js"
import {
  paymentRequiredSchema,
  paymentRequirementsSchema,
  type PaymentRequired,
  type PaymentRequirements,
  type ResourceInfo,
} from "./schemas.js"
import { DEFAULT_MAX_TIMEOUT_SECONDS, X402_VERSION } from "./version.js"

export interface CreatePaymentRequirementsInput {
  /** EVM chainId. */
  chainId: number
  /** Atomic units (string or bigint). */
  amountAtomic: string | bigint
  /** Merchant recipient address. */
  payTo: Address
  /** Max validity window for this authorization in seconds. */
  maxTimeoutSeconds?: number
  /**
   * Override the asset address. Defaults to the JPYC address registered for
   * the chain. Provided for forward-compatibility (e.g. wrapped JPYC).
   */
  asset?: Address
  /**
   * Override the EIP-712 domain `name`. Defaults to JPYC's "JPY Coin".
   * Provided for forward-compatibility.
   */
  domainName?: string
  /**
   * Override the EIP-712 domain `version`. Defaults to JPYC's "1".
   */
  domainVersion?: string
}

export function createPaymentRequirements(
  input: CreatePaymentRequirementsInput,
): PaymentRequirements {
  const chain = getJpycChain(input.chainId)
  const requirements: PaymentRequirements = {
    scheme: "exact",
    network: evmChainIdToCaip2(input.chainId),
    amount: typeof input.amountAtomic === "bigint" ? input.amountAtomic.toString() : input.amountAtomic,
    asset: (input.asset ?? chain.jpycAddress) as Address,
    payTo: input.payTo,
    maxTimeoutSeconds: input.maxTimeoutSeconds ?? DEFAULT_MAX_TIMEOUT_SECONDS,
    extra: {
      assetTransferMethod: "eip3009",
      name: input.domainName ?? chain.jpycDomainName,
      version: input.domainVersion ?? chain.jpycDomainVersion,
      decimals: JPYC_DECIMALS,
      symbol: "JPYC",
    },
  }
  // Final defensive parse — catches accidental drift between this file and the schema.
  return paymentRequirementsSchema.parse(requirements)
}

export interface CreatePaymentRequiredInput {
  resource: ResourceInfo | string
  accepts: PaymentRequirements[]
  /** Human-readable error explaining why payment is required. */
  error?: string
  /** Free-form extension metadata. */
  extensions?: Record<string, unknown>
}

export function createPaymentRequired(input: CreatePaymentRequiredInput): PaymentRequired {
  const resource: ResourceInfo =
    typeof input.resource === "string" ? { url: input.resource } : input.resource
  const required: PaymentRequired = {
    x402Version: X402_VERSION,
    error: input.error,
    resource,
    accepts: input.accepts,
    extensions: input.extensions,
  }
  return paymentRequiredSchema.parse(required)
}
