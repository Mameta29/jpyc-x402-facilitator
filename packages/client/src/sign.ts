/**
 * Sign an EIP-3009 `transferWithAuthorization` for a given PaymentRequirements.
 *
 * `signPaymentPayload` accepts a viem-compatible signer (anything that has
 * `signTypedData` and an `address`). It produces a fully-formed
 * `PaymentPayload` ready to drop into the `PAYMENT-SIGNATURE` header.
 */

import {
  TRANSFER_WITH_AUTHORIZATION_TYPES,
  buildJpycEip712Domain,
  caip2ToEvmChainId,
  type PaymentPayload,
  type PaymentRequirements,
  X402_VERSION,
} from "@jpyc-x402/shared"
import type { Account, Address, Hex, LocalAccount, WalletClient } from "viem"
import { generateRandomNonce } from "./nonce.js"

export interface SignerLike {
  address: Address
  signTypedData: LocalAccount["signTypedData"] | WalletClient["signTypedData"]
}

export interface SignPaymentInput {
  signer: SignerLike
  requirements: PaymentRequirements
  /** Override the random nonce (deterministic tests, replay tooling). */
  nonce?: Hex
  /**
   * Override the validAfter timestamp. Default `0` — the authorization is
   * valid from genesis, so clock skew between the signer and the chain can
   * never make it "not yet valid". Replay is bounded by `validBefore`.
   */
  validAfterSeconds?: bigint
  /** Override the validBefore timestamp (default: now + maxTimeoutSeconds). */
  validBeforeSeconds?: bigint
}

export async function signPaymentPayload(input: SignPaymentInput): Promise<PaymentPayload> {
  const chainId = caip2ToEvmChainId(input.requirements.network)
  const domain = buildJpycEip712Domain(chainId)
  const value = BigInt(input.requirements.amount)
  const nowSec = BigInt(Math.floor(Date.now() / 1000))
  const validAfter = input.validAfterSeconds ?? 0n
  const validBefore =
    input.validBeforeSeconds ?? nowSec + BigInt(input.requirements.maxTimeoutSeconds)
  const nonce = input.nonce ?? generateRandomNonce()

  const message = {
    from: input.signer.address,
    to: input.requirements.payTo as Address,
    value,
    validAfter,
    validBefore,
    nonce,
  }
  // viem's WalletClient.signTypedData has a slightly different signature than
  // LocalAccount.signTypedData. We call into both via a generic dispatch.
  const signFn: (args: unknown) => Promise<Hex> = (input.signer.signTypedData as unknown as (
    args: unknown,
  ) => Promise<Hex>).bind(input.signer)
  const signature = await signFn({
    domain,
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message,
    account: (input.signer as { address: Address }).address,
  })

  return {
    x402Version: X402_VERSION,
    accepted: input.requirements,
    payload: {
      signature,
      authorization: {
        from: input.signer.address,
        to: input.requirements.payTo,
        value: value.toString(),
        validAfter: validAfter.toString(),
        validBefore: validBefore.toString(),
        nonce,
      },
    },
  }
}

/** Helper: a viem Account also satisfies SignerLike. */
export function toSigner(account: Account): SignerLike {
  return {
    address: account.address,
    signTypedData: ((account as LocalAccount).signTypedData ??
      (() => {
        throw new Error("Account has no signTypedData; use a LocalAccount or WalletClient")
      })) as SignerLike["signTypedData"],
  }
}
