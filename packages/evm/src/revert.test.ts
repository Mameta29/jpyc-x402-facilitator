/**
 * Unit tests for `parseEip3009RevertReason` and `isRelayerGasExhaustionError`.
 *
 * Covers the EIP-3009 revert strings we map to wire error codes, the cause-
 * chain walk viem produces, and the unrecognised-revert fallthrough.
 */

import { describe, expect, it } from "vitest"
import { isRelayerGasExhaustionError, parseEip3009RevertReason } from "./revert.js"

describe("parseEip3009RevertReason", () => {
  it("maps 'authorization is expired' to the valid_before code", () => {
    expect(parseEip3009RevertReason("FiatTokenV2: authorization is expired")).toBe(
      "invalid_exact_evm_payload_authorization_valid_before",
    )
  })

  it("maps 'authorization is not yet valid' to the valid_after code", () => {
    expect(parseEip3009RevertReason("FiatTokenV2: authorization is not yet valid")).toBe(
      "invalid_exact_evm_payload_authorization_valid_after",
    )
  })

  it("maps a used authorization to invalid_transaction_state", () => {
    expect(parseEip3009RevertReason("FiatTokenV2: authorization is used or canceled")).toBe(
      "invalid_transaction_state",
    )
  })

  it("maps an invalid signature revert to the signature code", () => {
    expect(parseEip3009RevertReason("ECDSA: invalid signature")).toBe(
      "invalid_exact_evm_payload_signature",
    )
  })

  it("maps an ERC-20 balance shortfall to insufficient_funds", () => {
    expect(parseEip3009RevertReason("ERC20: transfer amount exceeds balance")).toBe(
      "insufficient_funds",
    )
  })

  it("is case-insensitive", () => {
    expect(parseEip3009RevertReason("AUTHORIZATION IS EXPIRED")).toBe(
      "invalid_exact_evm_payload_authorization_valid_before",
    )
  })

  it("walks the viem-style cause chain", () => {
    // viem nests the real revert reason a few levels down under `cause`.
    const err = new Error("The contract function reverted")
    ;(err as { shortMessage?: string }).shortMessage =
      'The contract function "transferWithAuthorization" reverted.'
    ;(err as { cause?: unknown }).cause = {
      shortMessage: "execution reverted",
      cause: {
        reason: "FiatTokenV2: authorization is expired",
      },
    }
    expect(parseEip3009RevertReason(err)).toBe(
      "invalid_exact_evm_payload_authorization_valid_before",
    )
  })

  it("reads metaMessages arrays viem attaches to ContractFunctionExecutionError", () => {
    const err = {
      message: "The contract function reverted",
      metaMessages: ["Contract Call:", "  reason: FiatTokenV2: authorization is used"],
    }
    expect(parseEip3009RevertReason(err)).toBe("invalid_transaction_state")
  })

  it("returns null for an unrecognised revert", () => {
    expect(parseEip3009RevertReason(new Error("nonce too low"))).toBeNull()
    expect(parseEip3009RevertReason("network is busy")).toBeNull()
  })

  it("returns null for empty or nullish input", () => {
    expect(parseEip3009RevertReason(null)).toBeNull()
    expect(parseEip3009RevertReason(undefined)).toBeNull()
    expect(parseEip3009RevertReason("")).toBeNull()
  })

  it("does not misclassify a relayer gas-exhaustion error as a contract revert", () => {
    // This is the regression that sent three teams chasing a non-existent
    // RPC bug: gas exhaustion is not an EIP-3009 revert.
    expect(parseEip3009RevertReason("insufficient funds for gas * price + value")).toBeNull()
  })
})

describe("isRelayerGasExhaustionError", () => {
  it("detects the geth/bor gas-funds rejection", () => {
    expect(isRelayerGasExhaustionError("insufficient funds for gas * price + value")).toBe(true)
  })

  it("detects the balance-comparison phrasing", () => {
    expect(
      isRelayerGasExhaustionError("err: insufficient funds for transfer (supplied gas ...)"),
    ).toBe(true)
  })

  it("detects the 'exceeds the balance of the account' phrasing", () => {
    expect(
      isRelayerGasExhaustionError(
        "The total cost (gas * gas fee + value) of executing this " +
          "transaction exceeds the balance of the account.",
      ),
    ).toBe(true)
  })

  it("is case-insensitive", () => {
    expect(isRelayerGasExhaustionError("INSUFFICIENT FUNDS FOR GAS")).toBe(true)
  })

  it("walks the viem cause chain to find the node error", () => {
    // viem wraps the raw RPC rejection under `cause` when `eth_sendRawTransaction`
    // is rejected for funds.
    const err = new Error("Transaction creation failed.")
    ;(err as { shortMessage?: string }).shortMessage = "Transaction creation failed."
    ;(err as { cause?: unknown }).cause = {
      shortMessage: "An internal error was received.",
      details: "insufficient funds for gas * price + value",
    }
    expect(isRelayerGasExhaustionError(err)).toBe(true)
  })

  it("does not fire on an EIP-3009 contract revert", () => {
    expect(isRelayerGasExhaustionError("FiatTokenV2: authorization is expired")).toBe(false)
    // The ERC-20 *token* balance shortfall is the payer's problem, not the
    // relayer's gas — it must stay classified as insufficient_funds, not this.
    expect(isRelayerGasExhaustionError("ERC20: transfer amount exceeds balance")).toBe(false)
  })

  it("returns false for unrelated errors and nullish input", () => {
    expect(isRelayerGasExhaustionError("nonce too low")).toBe(false)
    expect(isRelayerGasExhaustionError(new Error("network is busy"))).toBe(false)
    expect(isRelayerGasExhaustionError(null)).toBe(false)
    expect(isRelayerGasExhaustionError(undefined)).toBe(false)
    expect(isRelayerGasExhaustionError("")).toBe(false)
  })
})
