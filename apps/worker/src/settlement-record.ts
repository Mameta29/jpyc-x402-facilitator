import { keccak256, toHex } from "viem"
import type { DoBroadcastInput } from "./relayer-signer-do"

/** Bind a replay to the complete authorization, including its signature.
 * Hash only; don't duplicate signed payloads in diagnostics or logs. */
export function authorizationFingerprint(input: DoBroadcastInput): string {
  return keccak256(
    toHex(
      JSON.stringify([
        input.chainId,
        input.payer.toLowerCase(),
        input.payTo.toLowerCase(),
        BigInt(input.valueAtomic).toString(),
        BigInt(input.validAfter).toString(),
        BigInt(input.validBefore).toString(),
        input.nonce.toLowerCase(),
        input.signature.toLowerCase(),
      ]),
    ),
  )
}
