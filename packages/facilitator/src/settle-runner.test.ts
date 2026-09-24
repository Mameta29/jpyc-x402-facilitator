import { describe, it, expect, vi } from "vitest"
import { waitAndVerifyTransfer } from "./settle-runner"
import { getJpycChain } from "@jpyc-x402/shared"
import {
  AUTHORIZATION_USED_EVENT_SIGNATURE as AUTH,
  TRANSFER_EVENT_SIGNATURE as TRANSFER,
} from "@jpyc-x402/evm"
import type { Hex, PublicClient } from "viem"

const hash = `0x${"c".repeat(64)}` as Hex
const payer = `0x${"a".repeat(40)}` as Hex
const payTo = `0x${"b".repeat(40)}` as Hex
const nonce = `0x${"d".repeat(64)}` as Hex
const pad = (address: string) => `0x${address.slice(2).padStart(64, "0")}`
function setup() {
  const receipt = {
    status: "success",
    transactionHash: hash,
    blockNumber: 100n,
    gasUsed: 100n,
    effectiveGasPrice: 10n,
    logs: [
      {
        address: getJpycChain(137).jpycAddress,
        topics: [AUTH, pad(payer), nonce],
        data: "0x",
        removed: false,
      },
      {
        address: getJpycChain(137).jpycAddress,
        topics: [TRANSFER, pad(payer), pad(payTo)],
        data: "0x0",
        removed: false,
      },
    ],
  }
  const wait = vi.fn().mockResolvedValue(receipt)
  const client = {
    waitForTransactionReceipt: wait,
    getBlock: vi.fn().mockResolvedValue({ timestamp: 1000n }),
  } as unknown as PublicClient
  return { receipt, wait, client }
}
describe("receipt verification outside the broadcast lock", () => {
  it("verifies both authorization and transfer for a zero-JPYC payment", async () => {
    const { client, wait } = setup()
    expect(
      await waitAndVerifyTransfer(
        client,
        137,
        hash,
        { payer, payTo, valueAtomic: 0n, nonce },
        { receiptTimeoutMs: 8000 },
      ),
    ).toMatchObject({ ok: true, txHash: hash })
    expect(wait).toHaveBeenCalledWith({ hash, timeout: 8000 })
  })
  it("returns a known transaction as pending when the short wait expires", async () => {
    const { client, wait } = setup()
    wait.mockRejectedValue(new Error("RPC request timed out"))
    expect(
      await waitAndVerifyTransfer(
        client,
        137,
        hash,
        { payer, payTo, valueAtomic: 0n, nonce },
        { receiptTimeoutMs: 8000 },
      ),
    ).toEqual({ ok: false, reason: "receipt_pending", txHash: hash })
  })
  it.each(["payer", "nonce", "token", "transfer", "hash", "revert", "removed", "malformed"])(
    "rejects mismatched %s evidence",
    async (mode) => {
      const { client, receipt } = setup()
      if (mode === "payer") receipt.logs[0]!.topics[1] = pad(payTo)
      if (mode === "nonce") receipt.logs[0]!.topics[2] = hash
      if (mode === "token") receipt.logs[0]!.address = payer
      if (mode === "transfer") receipt.logs[1]!.data = "0x1"
      if (mode === "hash") receipt.transactionHash = nonce
      if (mode === "revert") receipt.status = "reverted"
      if (mode === "removed") receipt.logs[0]!.removed = true
      if (mode === "malformed") receipt.logs[1]!.data = "0x"
      expect(
        await waitAndVerifyTransfer(client, 137, hash, { payer, payTo, valueAtomic: 0n, nonce }),
      ).toMatchObject({ ok: false })
    },
  )
})
