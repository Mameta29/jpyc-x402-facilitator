import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { keccak256, toHex } from "viem"
import { AgentJournal } from "./agent-journal.js"
import type { PreparedPurchase } from "@jpyc-x402/evm/erc7710"

const dirs: string[] = [], journals: AgentJournal[] = []
afterEach(() => { for (const j of journals.splice(0)) j.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const a = (n: number) => toHex(n, { size: 20 }), h = (n: number) => toHex(n, { size: 32 })
function prepared(order = 1): PreparedPurchase {
  return { paymentKey: { method: "erc7710", network: "eip155:31337", payer: a(1), gate: a(2), orderId: h(order) }, intentHash: h(order+100), chainId: 31337, to: a(2), data: "0xabcdef", value: "0x0", notAfter: Math.floor(Date.now()/1000)+300,
    expected: { gate: a(2), orderId: h(order), orderHash: h(order+200), payer: a(1), payTo: a(3), token: a(4), amount: "1000", inputToken: a(0), maxInput: "0", riskDigest: h(8), approvalId: h(0) } }
}
const unsigned = { chainId: 31337, to: a(2), data: "0xabcdef" as const, value: "0" as const, gas: "100000", maxFeePerGas: "10", maxPriorityFeePerGas: "1" }
function open() { const dir = mkdtempSync(join(tmpdir(), "agent-journal-")); dirs.push(dir); const path = join(dir, "jobs.sqlite"); const j = new AgentJournal(path); journals.push(j); return { path, j } }

it("commits nonce and unsigned fields before signing, and recovers from a separate connection", () => {
  const { path, j } = open()
  const first = j.reserve(prepared(), "request-1", a(9), 7, unsigned)
  expect(first.raw_tx).toBeNull()
  const restarted = new AgentJournal(path); journals.push(restarted)
  expect(JSON.parse(restarted.get(first.payment_key)!.unsigned_tx)).toMatchObject({ nonce: 7, gas: "100000" })
  const second = restarted.reserve(prepared(2), "request-2", a(9), 7, unsigned)
  expect(JSON.parse(second.unsigned_tx).nonce).toBe(8)
  expect(j.reserve(prepared(), "request-1", a(9), 99, unsigned).unsigned_tx).toBe(first.unsigned_tx)
})
it("persists exact signed bytes/hash and never accepts a different transaction for that nonce", () => {
  const { path, j } = open(), job = j.reserve(prepared(), "request", a(9), 0, unsigned)
  const raw = "0x010203" as const
  j.storeRaw(job.payment_key, raw, keccak256(raw))
  const second = new AgentJournal(path); journals.push(second)
  expect(second.get(job.payment_key)).toMatchObject({ raw_tx: raw, tx_hash: keccak256(raw), state: "prepared" })
  expect(() => second.storeRaw(job.payment_key, "0x02", keccak256("0x02"))).toThrow("immutable")
})
it("rejects a new intent or revision under the same logical order", () => {
  const { j } = open(), p = prepared()
  j.reserve(p, "request", a(9), 0, unsigned)
  expect(() => j.reserve({ ...p, intentHash: h(999) }, "request-2", a(9), 0, unsigned)).toThrow("payment_key_conflict")
  expect(j.incomplete()).toHaveLength(1)
})
it("finalized records do not expire or get downgraded by late recovery work", () => {
  const { j } = open(), job = j.reserve(prepared(), "request", a(9), 0, unsigned)
  j.update(job.payment_key, "confirmed", { blockHash: h(8), blockNumber: "20" }, null, true)
  j.update(job.payment_key, "unknown", null, "rpc_timeout")
  expect(j.get(job.payment_key)!.state).toBe("confirmed")
  expect(j.incomplete()).toHaveLength(0)
})
it("refuses memory-only storage", () => { expect(() => new AgentJournal(":memory:")).toThrow("durable") })
