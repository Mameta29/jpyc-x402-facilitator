/**
 * Event signature topics for log scanning during settlement verification.
 *
 * Computed once and cached as constants to avoid per-call keccak.
 */

import { keccak256, toHex } from "viem"

export const TRANSFER_EVENT_SIGNATURE = keccak256(toHex("Transfer(address,address,uint256)"))
export const AUTHORIZATION_USED_EVENT_SIGNATURE = keccak256(
  toHex("AuthorizationUsed(address,bytes32)"),
)
