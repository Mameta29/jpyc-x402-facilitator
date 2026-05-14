/**
 * x402 `exact` scheme verification on EVM (JPYC).
 *
 * The 6 verification checks per `specs/schemes/exact/scheme_exact_evm.md`:
 *
 *   1. Signature recovers to authorization.from
 *   2. Payer has sufficient JPYC balance
 *   3. authorization parameters meet PaymentRequirements
 *      (amount match, recipient match, network match, asset match)
 *   4. Time window: now ∈ [validAfter, validBefore]
 *   5. Token + network match the requirement
 *   6. Simulate transferWithAuthorization to predict success
 *
 * Plus one facilitator-internal check (replay):
 *   7. The token contract's authorizationState(from, nonce) is still false.
 *      EIP-3009 ensures one-shot use, but checking proactively avoids paying
 *      gas for a transaction that will revert. JPYC implements
 *      `authorizationState(authorizer, nonce) → bool`.
 *
 * verifyExactPayment() returns a discriminated result; HTTP layer maps to
 * VerifyResponse / SettlementResponse fields.
 */

import {
  caip2ToEvmChainId,
  buildJpycEip712Domain,
  TRANSFER_WITH_AUTHORIZATION_TYPES,
  X402_ERROR_CODES,
  type PaymentPayload,
  type PaymentRequirements,
  getJpycChain,
} from "@jpyc-x402/shared"
import {
  type Address,
  type Hex,
  type PublicClient,
  type Account,
  hashTypedData,
  recoverAddress,
} from "viem"
import { JPYC_ABI } from "./abi.js"

export type VerifyOk = {
  ok: true
  payer: Address
  chainId: number
  asset: Address
  payTo: Address
  valueAtomic: bigint
  validAfter: bigint
  validBefore: bigint
  nonce: Hex
}

export type VerifyFail = {
  ok: false
  reason: string
  /** Best-effort recovered payer; only set when signature recovery succeeded. */
  payer?: Address
}

export type VerifyResult = VerifyOk | VerifyFail

interface VerifyDeps {
  publicClient: PublicClient
  /** Only used for the simulate step. Caller decides whose `from` to simulate as. */
  relayerAccount: Account
}

/**
 * Cross-validate that the client's chosen `accepted` block matches the
 * server's `paymentRequirements`. The fields the facilitator must enforce are:
 * scheme, network, amount, asset, payTo, extra.assetTransferMethod /
 * name / version. extra.decimals/symbol are advisory and we don't enforce them.
 */
export function checkRequirementsMatch(
  payload: PaymentPayload,
  required: PaymentRequirements,
): { ok: true } | { ok: false; reason: string } {
  if (payload.accepted.scheme !== required.scheme) return { ok: false, reason: "scheme mismatch" }
  if (payload.accepted.network !== required.network)
    return { ok: false, reason: "network mismatch" }
  if (payload.accepted.amount !== required.amount) return { ok: false, reason: "amount mismatch" }
  if (payload.accepted.asset.toLowerCase() !== required.asset.toLowerCase())
    return { ok: false, reason: "asset mismatch" }
  if (payload.accepted.payTo.toLowerCase() !== required.payTo.toLowerCase())
    return { ok: false, reason: "payTo mismatch" }
  if (payload.accepted.extra.assetTransferMethod !== required.extra.assetTransferMethod)
    return { ok: false, reason: "assetTransferMethod mismatch" }
  if (payload.accepted.extra.name !== required.extra.name)
    return { ok: false, reason: "extra.name mismatch (EIP-712 domain name)" }
  if (payload.accepted.extra.version !== required.extra.version)
    return { ok: false, reason: "extra.version mismatch (EIP-712 domain version)" }
  return { ok: true }
}

export async function verifyExactPayment(
  payload: PaymentPayload,
  required: PaymentRequirements,
  deps: VerifyDeps,
  now: () => bigint = () => BigInt(Math.floor(Date.now() / 1000)),
): Promise<VerifyResult> {
  // 0) requirements consistency
  const match = checkRequirementsMatch(payload, required)
  if (!match.ok) {
    return { ok: false, reason: `${X402_ERROR_CODES.invalid_payload}: ${match.reason}` }
  }

  const chainId = caip2ToEvmChainId(required.network)
  const chain = getJpycChain(chainId)
  if (chain.jpycAddress.toLowerCase() !== required.asset.toLowerCase()) {
    return {
      ok: false,
      reason: `${X402_ERROR_CODES.invalid_network}: asset ${required.asset} is not the registered JPYC address on chainId=${chainId}`,
    }
  }

  const a = payload.payload.authorization
  const sig = payload.payload.signature

  let valueAtomic: bigint
  let validAfter: bigint
  let validBefore: bigint
  try {
    valueAtomic = BigInt(a.value)
    validAfter = BigInt(a.validAfter)
    validBefore = BigInt(a.validBefore)
  } catch (e) {
    return { ok: false, reason: `${X402_ERROR_CODES.invalid_payload}: malformed integer field` }
  }

  // 1) signature recovery
  //
  // Reject signatures with high-s before recovery (EIP-2 / SEC1 §4.1.4).
  // viem's recoverAddress accepts both s and n-s as valid recoveries, but the
  // JPYC contract (FiatTokenV2 / OpenZeppelin ECDSA) rejects high-s. Today the
  // contract simulate step catches it; we reject here too so:
  //   (a) any future optimisation that skips simulate stays safe, and
  //   (b) an attacker cannot craft a malleable variant (r, n-s, v^1) that
  //       passes verify with a different-looking signature blob and bypasses
  //       the in-memory NonceCache (which keys on `nonce`, not on the sig).
  try {
    rejectHighS(sig as Hex)
  } catch (e) {
    return {
      ok: false,
      reason: `${X402_ERROR_CODES.invalid_exact_evm_payload_signature}: ${(e as Error).message}`,
    }
  }

  const domain = buildJpycEip712Domain(chain)
  const digest = hashTypedData({
    domain,
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from: a.from as Address,
      to: a.to as Address,
      value: valueAtomic,
      validAfter,
      validBefore,
      nonce: a.nonce as Hex,
    },
  })
  let recovered: Address
  try {
    recovered = await recoverAddress({ hash: digest, signature: sig as Hex })
  } catch (e) {
    return { ok: false, reason: X402_ERROR_CODES.invalid_exact_evm_payload_signature }
  }
  if (recovered.toLowerCase() !== a.from.toLowerCase()) {
    return {
      ok: false,
      reason: `${X402_ERROR_CODES.invalid_exact_evm_payload_signature}: recovered ${recovered} !== from ${a.from}`,
      payer: recovered as Address,
    }
  }

  // 3a) amount match (amount in requirements vs. value in authorization)
  if (a.value !== required.amount) {
    return {
      ok: false,
      reason: X402_ERROR_CODES.invalid_exact_evm_payload_authorization_value_mismatch,
      payer: a.from as Address,
    }
  }

  // 3b) recipient match (auth.to vs requirements.payTo)
  if (a.to.toLowerCase() !== required.payTo.toLowerCase()) {
    return {
      ok: false,
      reason: X402_ERROR_CODES.invalid_exact_evm_payload_recipient_mismatch,
      payer: a.from as Address,
    }
  }

  // 4) time window
  const t = now()
  if (t < validAfter) {
    return {
      ok: false,
      reason: X402_ERROR_CODES.invalid_exact_evm_payload_authorization_valid_after,
      payer: a.from as Address,
    }
  }
  if (t >= validBefore) {
    return {
      ok: false,
      reason: X402_ERROR_CODES.invalid_exact_evm_payload_authorization_valid_before,
      payer: a.from as Address,
    }
  }

  // 7) replay: nonce already consumed?
  try {
    const used = await deps.publicClient.readContract({
      address: chain.jpycAddress,
      abi: JPYC_ABI,
      functionName: "authorizationState",
      args: [a.from as Address, a.nonce as Hex],
    })
    if (used) {
      return {
        ok: false,
        reason: `${X402_ERROR_CODES.invalid_exact_evm_payload_signature}: nonce already used`,
        payer: a.from as Address,
      }
    }
  } catch (e) {
    // Don't hard-fail verification just because the read failed — settlement
    // simulation below will catch a true conflict. We do log it though, so
    // that a flaky RPC erasing our pre-broadcast replay check doesn't go
    // silently unnoticed in production.
    console.warn(
      `[verify] authorizationState read failed for chainId=${chainId} ` +
        `payer=${a.from} nonce=${a.nonce} — falling through to simulate. ` +
        `cause: ${e instanceof Error ? e.message : String(e)}`,
    )
  }

  // 2) balance check
  let balance: bigint
  try {
    balance = (await deps.publicClient.readContract({
      address: chain.jpycAddress,
      abi: JPYC_ABI,
      functionName: "balanceOf",
      args: [a.from as Address],
    })) as bigint
  } catch (e) {
    return {
      ok: false,
      reason: `${X402_ERROR_CODES.unexpected_verify_error}: balance read failed`,
      payer: a.from as Address,
    }
  }
  if (balance < valueAtomic) {
    return {
      ok: false,
      reason: X402_ERROR_CODES.insufficient_funds,
      payer: a.from as Address,
    }
  }

  // 6) simulate
  try {
    const { v, r, s } = splitSignatureComponents(sig as Hex)
    await deps.publicClient.simulateContract({
      address: chain.jpycAddress,
      abi: JPYC_ABI,
      functionName: "transferWithAuthorization",
      args: [
        a.from as Address,
        a.to as Address,
        valueAtomic,
        validAfter,
        validBefore,
        a.nonce as Hex,
        v,
        r,
        s,
      ],
      account: deps.relayerAccount,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return {
      ok: false,
      reason: `${X402_ERROR_CODES.invalid_transaction_state}: simulation reverted: ${msg.slice(0, 240)}`,
      payer: a.from as Address,
    }
  }

  return {
    ok: true,
    payer: a.from as Address,
    chainId,
    asset: chain.jpycAddress,
    payTo: a.to as Address,
    valueAtomic,
    validAfter,
    validBefore,
    nonce: a.nonce as Hex,
  }
}

/** Split a 65-byte ECDSA signature `0x{r}{s}{v}` into the v/r/s tuple. */
export function splitSignatureComponents(sig: Hex): { v: number; r: Hex; s: Hex } {
  if (!/^0x[a-fA-F0-9]{130}$/.test(sig)) {
    throw new Error(`bad signature length: ${sig.length}`)
  }
  const r = `0x${sig.slice(2, 66)}` as Hex
  const s = `0x${sig.slice(66, 130)}` as Hex
  const v = parseInt(sig.slice(130, 132), 16)
  return { v, r, s }
}

/**
 * secp256k1 group order n divided by 2. Per EIP-2, only signatures with
 * s ≤ n/2 are considered canonical; the JPYC contract rejects the upper half.
 */
const SECP256K1_N_HALF = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n

/**
 * Throw if the signature's s component lies in the upper half of the secp256k1
 * group order. Together with on-chain enforcement this gives defence in depth
 * against signature malleability — see verify.ts inline comment for the full
 * rationale.
 */
export function rejectHighS(sig: Hex): void {
  const { s } = splitSignatureComponents(sig)
  const sBig = BigInt(s)
  if (sBig > SECP256K1_N_HALF) {
    throw new Error("non-canonical signature (high-s)")
  }
}
