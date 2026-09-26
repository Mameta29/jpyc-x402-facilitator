import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it, vi } from "vitest"
import { privateKeyToAccount } from "viem/accounts"
import { keccak256, toHex, type Hex } from "viem"
import { paymentKeyId } from "@jpyc-ec/agent-commerce"
import { AgentPurchaseEngine, type PreparedPurchase } from "@jpyc-x402/evm/erc7710"
import type { AgentVerifyRequest } from "@jpyc-x402/shared"
import { AgentJournal } from "./agent-journal.js"
import { DurableAgentRunner } from "./agent-runner.js"

it("recovers lost broadcast responses after process restart without signing or paying twice", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-restart-")), path = join(dir, "journal.sqlite")
  let journal = new AgentJournal(path)
  const account = privateKeyToAccount(toHex(987654321, { size: 32 })) // local signing fixture, never funded
  const a = (n: number) => toHex(n, { size: 20 }), h = (n: number) => toHex(n, { size: 32 })
  const prepared: PreparedPurchase = { paymentKey: { method: "erc7710", network: "eip155:31337", payer: a(1), gate: a(2), orderId: h(3) }, intentHash: h(4), chainId: 31337, to: a(2), data: "0xabcdef", value: "0x0", notAfter: Math.floor(Date.now()/1000)+60,
    expected: { gate: a(2), orderId: h(3), orderHash: h(5), payer: a(1), payTo: a(6), token: a(7), amount: "1000", inputToken: a(0), maxInput: "0", riskDigest: h(8), approvalId: h(0) } }
  const request = { paymentPayload: { payload: { delegator: a(1) } }, paymentRequirements: { network: "eip155:31337" } } as AgentVerifyRequest
  const broadcasts: Hex[] = []; let receiptVisible = false
  const engine = {
    relayer: account.address, prepare: vi.fn(async () => prepared), unpaidAfterFinality: vi.fn(async () => false), verifyReceipt: vi.fn(() => true),
    client: {
      getTransactionCount: async () => 0, estimateGas: async () => 100000n, estimateFeesPerGas: async () => ({ maxFeePerGas: 10n, maxPriorityFeePerGas: 1n }),
      getTransactionReceipt: async () => { if (!receiptVisible) throw new Error("missing"); return { status: "success", blockHash: h(9), blockNumber: 1n } },
      getBlock: async ({ blockTag }: { blockTag?: string }) => ({ hash: h(9), number: blockTag === "finalized" ? 0n : 1n }), getBlockNumber: async () => 2n,
      sendRawTransaction: async ({ serializedTransaction }: { serializedTransaction: Hex }) => {
        const stored = journal.get(paymentKeyId(prepared.paymentKey))!
        expect(stored.raw_tx).toBe(serializedTransaction)
        expect(stored.tx_hash).toBe(keccak256(serializedTransaction))
        broadcasts.push(serializedTransaction)
        throw new Error("accepted by RPC; HTTP response lost")
      },
    },
  } as unknown as AgentPurchaseEngine
  try {
    const first = new DurableAgentRunner(engine, journal, account)
    const result = await first.settle(request)
    expect(result.errorReason).toBe("settlement_pending")
    expect(result.transaction).toBe(keccak256(broadcasts[0]!))
    journal.close(); journal = new AgentJournal(path)
    const restarted = new DurableAgentRunner(engine, journal, account)
    await restarted.reconcile()
    expect(broadcasts).toHaveLength(2)
    expect(broadcasts[1]).toBe(broadcasts[0])
    receiptVisible = true
    const recovered = await restarted.settle(request)
    expect(recovered.success).toBe(true)
    expect(recovered.transaction).toBe(result.transaction)
    expect(engine.prepare).toHaveBeenCalledTimes(1)
    expect(broadcasts).toHaveLength(2)
  } finally { journal.close(); rmSync(dir, { recursive: true, force: true }) }
})
