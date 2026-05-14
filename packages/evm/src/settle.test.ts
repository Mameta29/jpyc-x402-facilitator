/**
 * Unit tests for `settleExactPayment`.
 *
 * We mock viem's WalletClient + PublicClient so we can drive each branch
 * deterministically:
 *   - happy path (broadcast → receipt success → Transfer event matches)
 *   - broadcast failure (writeContract throws)
 *   - receipt wait failure (waitForTransactionReceipt throws)
 *   - tx mined but reverted (receipt.status = "reverted")
 *   - receipt logs do not contain the expected Transfer event
 *
 * The e2e test on Polygon Amoy covers a real broadcast end-to-end; this
 * file is the regression net for the in-process logic that turns a receipt
 * into a SettleResult.
 */

import { describe, expect, it, vi } from "vitest"
import type { Hex } from "viem"
import { JPYC_CHAINS } from "@jpyc-x402/shared"
import { TRANSFER_EVENT_SIGNATURE } from "./events.js"
import { settleExactPayment } from "./settle.js"
import type { VerifyOk } from "./verify.js"

const CHAIN = JPYC_CHAINS.find((c) => c.chainId === 80002)!
const PAYER = "0x1111111111111111111111111111111111111111" as const
const PAYTO = "0x2222222222222222222222222222222222222222" as const
const VALUE = 1_000_000_000_000_000_000n
const NONCE = ("0x" + "ab".repeat(32)) as Hex
const TX_HASH = ("0x" + "cd".repeat(32)) as Hex
const SIGNATURE = ("0x" + "ee".repeat(64) + "1c") as Hex

const verified: VerifyOk = {
  ok: true,
  payer: PAYER,
  chainId: CHAIN.chainId,
  asset: CHAIN.jpycAddress,
  payTo: PAYTO,
  valueAtomic: VALUE,
  validAfter: 0n,
  validBefore: 9_999_999_999n,
  nonce: NONCE,
}

function transferLog(
  opts: {
    address?: string
    from?: string
    to?: string
    value?: bigint
  } = {},
) {
  const from = (opts.from ?? PAYER).toLowerCase().replace(/^0x/, "")
  const to = (opts.to ?? PAYTO).toLowerCase().replace(/^0x/, "")
  return {
    address: opts.address ?? CHAIN.jpycAddress,
    topics: [
      TRANSFER_EVENT_SIGNATURE,
      ("0x" + from.padStart(64, "0")) as Hex,
      ("0x" + to.padStart(64, "0")) as Hex,
    ] as readonly Hex[],
    data: ("0x" + (opts.value ?? VALUE).toString(16).padStart(64, "0")) as Hex,
  }
}

interface MockOpts {
  writeThrows?: Error
  waitThrows?: Error
  receiptStatus?: "success" | "reverted"
  logs?: ReturnType<typeof transferLog>[]
  blockTimestamp?: bigint
  blockThrows?: Error
}

function buildDeps(opts: MockOpts = {}) {
  const walletClient = {
    chain: { id: CHAIN.chainId },
    writeContract: vi.fn(async () => {
      if (opts.writeThrows) throw opts.writeThrows
      return TX_HASH
    }),
  }
  const publicClient = {
    waitForTransactionReceipt: vi.fn(async () => {
      if (opts.waitThrows) throw opts.waitThrows
      return {
        status: opts.receiptStatus ?? "success",
        blockNumber: 1234n,
        gasUsed: 21_000n,
        effectiveGasPrice: 30_000_000_000n,
        logs: opts.logs ?? [transferLog()],
      }
    }),
    getBlock: vi.fn(async () => {
      if (opts.blockThrows) throw opts.blockThrows
      return { timestamp: opts.blockTimestamp ?? 1_700_000_000n }
    }),
  }
  const relayerAccount = { address: "0x3333333333333333333333333333333333333333" }

  return {
    deps: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      walletClient: walletClient as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      publicClient: publicClient as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      relayerAccount: relayerAccount as any,
    },
    walletClient,
    publicClient,
  }
}

describe("settleExactPayment", () => {
  it("returns ok with tx metadata on the happy path", async () => {
    const { deps } = buildDeps()
    const res = await settleExactPayment(verified, SIGNATURE, deps)
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.txHash).toBe(TX_HASH)
      expect(res.blockNumber).toBe(1234n)
      expect(res.gasUsed).toBe(21_000n)
      expect(res.effectiveGasPrice).toBe(30_000_000_000n)
      expect(Number(res.gasCostNative)).toBeGreaterThan(0)
      expect(res.blockTimestamp).toBeInstanceOf(Date)
    }
  })

  it("returns failure (no txHash) when broadcast throws", async () => {
    const { deps } = buildDeps({
      writeThrows: new Error("nonce too low"),
    })
    const res = await settleExactPayment(verified, SIGNATURE, deps)
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.reason).toMatch(/tx broadcast failed/)
      expect(res.reason).toMatch(/nonce too low/)
      expect(res.txHash).toBeUndefined()
    }
  })

  it("returns failure (with txHash) when receipt wait throws", async () => {
    const { deps } = buildDeps({
      waitThrows: new Error("timed out after 120s"),
    })
    const res = await settleExactPayment(verified, SIGNATURE, deps)
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.reason).toMatch(/receipt wait failed/)
      expect(res.reason).toMatch(/timed out/)
      expect(res.txHash).toBe(TX_HASH)
    }
  })

  it("returns failure when the receipt is mined but reverted", async () => {
    const { deps } = buildDeps({ receiptStatus: "reverted" })
    const res = await settleExactPayment(verified, SIGNATURE, deps)
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.reason).toMatch(/tx reverted on-chain/)
      expect(res.txHash).toBe(TX_HASH)
    }
  })

  it("returns failure when no Transfer log matches expected (payer, payTo, value)", async () => {
    // Receipt mined success but the Transfer event has the wrong recipient.
    const { deps } = buildDeps({
      logs: [transferLog({ to: "0x9999999999999999999999999999999999999999" })],
    })
    const res = await settleExactPayment(verified, SIGNATURE, deps)
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.reason).toMatch(/Transfer event in receipt did not match/)
      expect(res.txHash).toBe(TX_HASH)
    }
  })

  it("ignores Transfer events from other contracts on the same receipt", async () => {
    // First log is a Transfer from a foreign contract (e.g. an unrelated ERC-20
    // routed in the same block). The matching JPYC log comes second.
    const { deps } = buildDeps({
      logs: [transferLog({ address: "0x4444444444444444444444444444444444444444" }), transferLog()],
    })
    const res = await settleExactPayment(verified, SIGNATURE, deps)
    expect(res.ok).toBe(true)
  })

  it("still returns ok when getBlock fails (blockTimestamp is best-effort)", async () => {
    const { deps } = buildDeps({
      blockThrows: new Error("rpc unavailable"),
    })
    const res = await settleExactPayment(verified, SIGNATURE, deps)
    expect(res.ok).toBe(true)
    if (res.ok) {
      // Falls back to epoch (timestamp 0).
      expect(res.blockTimestamp.getTime()).toBe(0)
    }
  })
})
