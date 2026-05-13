/**
 * EIP-712 domain + typed-data builder for EIP-3009 `transferWithAuthorization`
 * on JPYC.
 *
 * Layout reflects JPYC's on-chain implementation:
 *   - Domain `name` = "JPY Coin"
 *   - Domain `version` = "1"
 *   - chainId        = the EVM chainId on which the token lives
 *   - verifyingContract = the JPYC token address on that chain
 *
 * The typed-data object is shaped for `viem`'s `signTypedData` and matches
 * x402's exact-EVM scheme (`extra.assetTransferMethod = "eip3009"`). It is
 * intentionally chain-agnostic: callers pass the chain row from `chains.ts`
 * so we never silently fall back to the wrong domain.
 */

import type { Address, Hex, TypedDataDomain } from "viem"
import { getJpycChain, type JpycChain } from "./chains.js"

export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const

export const RECEIVE_WITH_AUTHORIZATION_TYPES = {
  ReceiveWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const

export interface AuthorizationMessage {
  from: Address
  to: Address
  /** Atomic units (string to preserve precision through JSON). */
  value: bigint
  validAfter: bigint
  validBefore: bigint
  nonce: Hex
}

export function buildJpycEip712Domain(chain: JpycChain | number): TypedDataDomain {
  const c = typeof chain === "number" ? getJpycChain(chain) : chain
  return {
    name: c.jpycDomainName,
    version: c.jpycDomainVersion,
    chainId: c.chainId,
    verifyingContract: c.jpycAddress,
  }
}

/**
 * Build a viem-compatible typed-data object for signing. The x402 `exact`
 * scheme uses `TransferWithAuthorization` (not `ReceiveWithAuthorization`)
 * because the facilitator — not the recipient — is the on-chain msg.sender,
 * and `receiveWithAuthorization` constrains `to == msg.sender`.
 */
export function buildTransferWithAuthorizationTypedData(params: {
  chain: JpycChain | number
  message: AuthorizationMessage
}) {
  return {
    domain: buildJpycEip712Domain(params.chain),
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization" as const,
    message: params.message,
  }
}

/** Same shape as above, for the recipient-restricted variant. */
export function buildReceiveWithAuthorizationTypedData(params: {
  chain: JpycChain | number
  message: AuthorizationMessage
}) {
  return {
    domain: buildJpycEip712Domain(params.chain),
    types: RECEIVE_WITH_AUTHORIZATION_TYPES,
    primaryType: "ReceiveWithAuthorization" as const,
    message: params.message,
  }
}
