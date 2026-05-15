/**
 * x402 `exact` scheme settlement on EVM (JPYC).
 *
 * Once verifyExactPayment() returns ok, settle() broadcasts
 * `transferWithAuthorization` and waits for the receipt. We then re-verify
 * the on-chain Transfer event matches the expected (from, to, value) tuple
 * before declaring success — this catches the (unlikely) case where the RPC
 * returns a receipt for the wrong tx.
 *
 * The settle step is intentionally *not* idempotent at this layer. Callers
 * must do their own dedupe (the facilitator package uses a Postgres row
 * keyed on (chainId, payer, nonce) before broadcasting).
 */

import {
  TRANSFER_EVENT_SIGNATURE,
} from "./events.js"
import { JPYC_ABI } from "./abi.js"
import { checkTimeWindow, splitSignatureComponents, type VerifyOk } from "./verify.js"
import { parseEip3009RevertReason } from "./revert.js"
import {
  type Account,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  formatEther,
} from "viem"
import { X402_ERROR_CODES, getJpycChain } from "@jpyc-x402/shared"

export interface SettleOk {
  ok: true
  txHash: Hex
  blockNumber: bigint
  blockTimestamp: Date
  gasUsed: bigint
  effectiveGasPrice: bigint
  gasCostNative: string
}

export interface SettleFail {
  ok: false
  reason: string
  /** May be set if the tx was sent but reverted or post-checks failed. */
  txHash?: Hex
}

export type SettleResult = SettleOk | SettleFail

export interface SettleDeps {
  publicClient: PublicClient
  walletClient: WalletClient
  relayerAccount: Account
}

export async function settleExactPayment(
  verified: VerifyOk,
  signature: Hex,
  deps: SettleDeps,
  opts: { receiptTimeoutMs?: number } = {},
): Promise<SettleResult> {
  const chain = getJpycChain(verified.chainId)
  const { v, r, s } = splitSignatureComponents(signature)

  // Re-check the time window just before broadcast. verifyExactPayment ran
  // this same check, but settle is serialised per chain (in-process mutex /
  // Durable Object) and the window can close while waiting for the lock.
  const timeError = checkTimeWindow(
    verified.validAfter,
    verified.validBefore,
    BigInt(Math.floor(Date.now() / 1000)),
  )
  if (timeError) {
    return { ok: false, reason: timeError }
  }

  let txHash: Hex
  try {
    txHash = await deps.walletClient.writeContract({
      address: chain.jpycAddress,
      abi: JPYC_ABI,
      functionName: "transferWithAuthorization",
      args: [
        verified.payer,
        verified.payTo,
        verified.valueAtomic,
        verified.validAfter,
        verified.validBefore,
        verified.nonce,
        v,
        r,
        s,
      ],
      account: deps.relayerAccount,
      // viem complains without a chain even though wallet client has one
      chain: deps.walletClient.chain,
    })
  } catch (e) {
    // writeContract simulates before sending; a revert (e.g. an expired
    // authorization) lands here. Map known EIP-3009 revert strings to a wire
    // error code so the HTTP layer returns a meaningful `errorReason`.
    const code = parseEip3009RevertReason(e)
    if (code) return { ok: false, reason: code }
    const msg = e instanceof Error ? e.message : String(e)
    return {
      ok: false,
      reason: `${X402_ERROR_CODES.unexpected_settle_error}: ${msg.slice(0, 240)}`,
    }
  }

  let receipt
  try {
    receipt = await deps.publicClient.waitForTransactionReceipt({
      hash: txHash,
      timeout: opts.receiptTimeoutMs ?? 120_000,
    })
  } catch (e) {
    return { ok: false, reason: `receipt wait failed: ${(e as Error).message}`, txHash }
  }

  if (receipt.status !== "success") {
    return { ok: false, reason: `tx reverted on-chain`, txHash }
  }

  // Verify the Transfer event in the receipt matches what we expected.
  const verified1 = receipt.logs.some((log) => {
    if (log.address.toLowerCase() !== chain.jpycAddress.toLowerCase()) return false
    if (log.topics[0] !== TRANSFER_EVENT_SIGNATURE) return false
    const from = `0x${log.topics[1]?.slice(-40)}`
    const to = `0x${log.topics[2]?.slice(-40)}`
    if (from.toLowerCase() !== verified.payer.toLowerCase()) return false
    if (to.toLowerCase() !== verified.payTo.toLowerCase()) return false
    const value = BigInt(log.data)
    return value === verified.valueAtomic
  })
  if (!verified1) {
    return {
      ok: false,
      reason: `Transfer event in receipt did not match expected (payer, payTo, value)`,
      txHash,
    }
  }

  let blockTimestampSec = 0n
  try {
    const block = await deps.publicClient.getBlock({ blockNumber: receipt.blockNumber })
    blockTimestampSec = block.timestamp
  } catch {
    // best effort — leave as zero, caller can backfill from explorer if it cares
  }

  const gasCostWei = receipt.gasUsed * receipt.effectiveGasPrice
  return {
    ok: true,
    txHash,
    blockNumber: receipt.blockNumber,
    blockTimestamp: new Date(Number(blockTimestampSec) * 1000),
    gasUsed: receipt.gasUsed,
    effectiveGasPrice: receipt.effectiveGasPrice,
    gasCostNative: formatEther(gasCostWei),
  }
}
