import "./durable-test-clock"
import { env, runInDurableObject, runDurableObjectAlarm } from "cloudflare:test"
import { describe, expect, it, vi } from "vitest"
import { keccak256, parseTransaction, type Hex } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import type { RelayerSignerDO, DoBroadcastInput } from "../src/relayer-signer-do"
import type { WorkerEnv } from "../src/env"

// Published test key only. No real RPC, funds or production wallets.
const account = privateKeyToAccount(`0x${"1".repeat(64)}`)
function input(n: number): DoBroadcastInput {
  return {
    chainId: 137,
    payer: `0x${"a".repeat(40)}`,
    payTo: `0x${n.toString(16).padStart(40, "0")}`,
    valueAtomic: "0",
    validAfter: "0",
    validBefore: String(Math.floor(Date.now() / 1000) + 180),
    nonce: `0x${n.toString(16).padStart(64, "0")}`,
    signature: `0x${"d".repeat(128)}1b`,
  }
}
function stub() {
  const ns = (env as unknown as WorkerEnv).RELAYER
  return ns.get(ns.idFromName(crypto.randomUUID())) as unknown as DurableObjectStub<RelayerSignerDO>
}

describe("durable relayer journal under concurrency and faults", () => {
  it("keeps chains outside the rollout on the previous sender without allocating a durable nonce", async () => {
    const object = stub()
    await runInDurableObject(object, async (instance, state) => {
      const broadcast = vi.fn().mockResolvedValue({ ok: true, txHash: `0x${"e".repeat(64)}` })
      Object.defineProperty(instance, "env", { value: { DURABLE_SETTLEMENT_CHAINS: "1001,11155111" } })
      Object.defineProperty(instance, "legacy", { value: { broadcast } })
      const payment = { ...input(1), chainId: 80002 }
      expect(await instance.broadcast(payment)).toMatchObject({ ok: true })
      expect(broadcast).toHaveBeenCalledWith(payment)
      expect((await state.storage.list()).size).toBe(0)
      expect(await state.storage.getAlarm()).toBeNull()
    })
  })

  it("persists bytes before sending and allocates 64 unique nonces while RPC sends overlap", async () => {
    const object = stub()
    await runInDurableObject(object, async (instance, state) => {
      const nonces: number[] = []
      let sending = 0,
        peakSending = 0
      Object.defineProperty(instance, "getAccount", { value: () => account })
      Object.defineProperty(instance, "clients", {
        value: () => ({
          wallet: {
            prepareTransactionRequest: async () => ({
              type: "eip1559",
              gas: 100_000n,
              maxFeePerGas: 60_000_000_000n,
              maxPriorityFeePerGas: 30_000_000_000n,
            }),
          },
          public: {
            getTransactionCount: async () => 7,
            sendRawTransaction: async ({
              serializedTransaction,
            }: {
              serializedTransaction: Hex
            }) => {
              const tx = parseTransaction(serializedTransaction)
              const rows = await state.storage.list<{ rawTransaction: Hex; txHash: Hex }>({
                prefix: "settle:",
              })
              expect(
                [...rows.values()].some(
                  (row) =>
                    row.rawTransaction === serializedTransaction &&
                    row.txHash === keccak256(serializedTransaction),
                ),
              ).toBe(true)
              nonces.push(tx.nonce!)
              peakSending = Math.max(peakSending, ++sending)
              await new Promise((resolve) => setTimeout(resolve, 10))
              sending--
              return keccak256(serializedTransaction)
            },
          },
        }),
      })
      const cases = Array.from({ length: 64 }, (_, n) => input(n + 1))
      const results = await Promise.all(cases.map((payment) => instance.broadcast(payment)))
      expect(results.every((result) => result.ok)).toBe(true)
      for (const result of results) {
        expect(result.ok && result.timeline?.broadcastAt).toBeTypeOf("number")
        if (result.ok) expect(result.timeline!.broadcastAt).toBeGreaterThanOrEqual(result.timeline!.broadcastStartedAt!)
      }
      expect(new Set(nonces).size).toBe(64)
      expect(Math.min(...nonces)).toBe(7)
      expect(Math.max(...nonces)).toBe(70)
      expect(peakSending).toBeGreaterThan(1)
      expect((await state.storage.list({ prefix: "due:" })).size).toBe(64)
      expect(await state.storage.getAlarm()).not.toBeNull()
      const publicRecord = await instance.getSettleRecord(cases[0]!.payer, cases[0]!.nonce)
      expect(publicRecord).not.toHaveProperty("rawTransaction")
      expect(publicRecord).not.toHaveProperty("input")
      await state.storage.deleteAll()
    })
  })

  it("retains the same raw bytes and hash after a lost send response, with idempotent retries", async () => {
    const object = stub()
    await runInDurableObject(object, async (instance, state) => {
      const sent: Hex[] = []
      let prepareCalls = 0
      Object.defineProperty(instance, "getAccount", { value: () => account })
      Object.defineProperty(instance, "clients", {
        value: () => ({
          wallet: {
            prepareTransactionRequest: async () => {
              prepareCalls++
              return { type: "legacy", gas: 100_000n, gasPrice: 60_000_000_000n }
            },
          },
          public: {
            getTransactionCount: async () => 9,
            sendRawTransaction: async ({
              serializedTransaction,
            }: {
              serializedTransaction: Hex
            }) => {
              sent.push(serializedTransaction)
              throw new Error("RPC accepted request, response lost")
            },
          },
        }),
      })
      const payment = input(2)
      const first = await instance.broadcast(payment)
      const second = await instance.broadcast(payment)
      expect(first).toMatchObject({ ok: true })
      expect(second).toMatchObject({
        ok: true,
        replayed: true,
        txHash: first.ok ? first.txHash : "",
      })
      expect(prepareCalls).toBe(1)
      expect(sent).toHaveLength(2)
      expect(sent[0]).toBe(sent[1])
      const saved = await state.storage.get<{ rawTransaction: Hex; state: string }>(
        `settle:${payment.payer}:${payment.nonce}`,
      )
      expect(saved).toMatchObject({ rawTransaction: sent[0], state: "prepared" })
      expect(await state.storage.getAlarm()).not.toBeNull()
      await state.storage.deleteAll()
    })
  })

  it("does not broadcast or consume a nonce when local signing fails", async () => {
    const object = stub()
    await runInDurableObject(object, async (instance, state) => {
      let sends = 0
      Object.defineProperty(instance, "getAccount", {
        value: () => ({
          ...account,
          signTransaction: async () => {
            throw new Error("local signer unavailable")
          },
        }),
      })
      Object.defineProperty(instance, "clients", {
        value: () => ({
          wallet: {
            prepareTransactionRequest: async () => ({
              type: "legacy",
              gas: 100_000n,
              gasPrice: 1n,
            }),
          },
          public: {
            getTransactionCount: async () => 9,
            sendRawTransaction: async () => {
              sends++
              return "0x"
            },
          },
        }),
      })
      expect(await instance.broadcast(input(3))).toMatchObject({ ok: false })
      expect(sends).toBe(0)
      expect((await state.storage.list({ prefix: "settle:" })).size).toBe(0)
      expect((await state.storage.list({ prefix: "next-nonce:" })).size).toBe(0)
    })
  })

  it("rolls back the journal and nonce if committing the storage transaction fails", async () => {
    const object = stub()
    await runInDurableObject(object, async (instance, state) => {
      let sends = 0
      Object.defineProperty(instance, "getAccount", { value: () => account })
      Object.defineProperty(instance, "clients", {
        value: () => ({
          wallet: {
            prepareTransactionRequest: async () => ({
              type: "legacy",
              gas: 100_000n,
              gasPrice: 1n,
            }),
          },
          public: {
            getTransactionCount: async () => 9,
            sendRawTransaction: async () => {
              sends++
              return "0x"
            },
          },
        }),
      })
      const transaction = state.storage.transaction.bind(state.storage)
      const failure = vi.spyOn(state.storage, "transaction").mockImplementation((callback) =>
        transaction(async (txn) => {
          await callback(txn)
          throw new Error("simulated commit failure")
        }),
      )
      expect(await instance.broadcast(input(5))).toMatchObject({ ok: false })
      failure.mockRestore()
      expect(sends).toBe(0)
      expect((await state.storage.list({ prefix: "settle:" })).size).toBe(0)
      expect((await state.storage.list({ prefix: "next-nonce:" })).size).toBe(0)
    })
  })

  it("caps an unmined backlog without allocating a nonce or broadcasting another payment", async () => {
    const object = stub()
    await runInDurableObject(object, async (instance, state) => {
      const send = vi.fn()
      Object.defineProperty(instance, "getAccount", { value: () => account })
      Object.defineProperty(instance, "clients", {
        value: () => ({
          wallet: {
            prepareTransactionRequest: async () => ({
              type: "legacy",
              gas: 100_000n,
              gasPrice: 1n,
            }),
          },
          public: {
            getTransactionCount: async ({ blockTag }: { blockTag: string }) =>
              blockTag === "latest" ? 1 : 129,
            sendRawTransaction: send,
          },
        }),
      })
      expect(await instance.broadcast(input(6))).toMatchObject({
        ok: false,
        reason: "relayer_capacity_reached",
      })
      expect(send).not.toHaveBeenCalled()
      expect((await state.storage.list({ prefix: "settle:" })).size).toBe(0)
    })
  })

  it.each(["legacy", "eip1559"] as const)(
    "replaces only fees, caps replacements, and accepts the original winning hash (%s)",
    async (type) => {
      const object = stub()
      await runInDurableObject(object, async (instance, state) => {
        Object.defineProperty(instance, "getAccount", { value: () => account })
        let feeEstimate = 1n
        const rpc = {
          getTransactionCount: async () => 9,
          getGasPrice: async () => feeEstimate,
          estimateFeesPerGas: async () => ({
            maxFeePerGas: feeEstimate,
            maxPriorityFeePerGas: feeEstimate,
          }),
          sendRawTransaction: async ({ serializedTransaction }: { serializedTransaction: Hex }) =>
            keccak256(serializedTransaction),
        }
        Object.defineProperty(instance, "clients", {
          value: () => ({
            wallet: {
              prepareTransactionRequest: async () => ({
                type,
                gas: 100_000n,
                gasPrice: 100n,
                maxFeePerGas: 100n,
                maxPriorityFeePerGas: 10n,
              }),
            },
            public: rpc,
          }),
        })
        const payment = input(7),
          key = `settle:${payment.payer}:${payment.nonce}`
        await instance.broadcast(payment)
        type Row = {
          rawTransaction: Hex
          txHash: Hex
          previousTransactions?: { txHash: Hex; rawTransaction: Hex }[]
        }
        let row = (await state.storage.get<Row>(key))!
        const original = row
        const replace = Reflect.get(instance, "bumpFees").bind(instance) as (
          key: string,
          row: Row,
        ) => Promise<Row>
        feeEstimate = 401n
        expect((await replace(key, row)).txHash).toBe(original.txHash)
        feeEstimate = 1n
        for (let i = 0; i < 4; i++) row = await replace(key, row)
        expect(row.previousTransactions).toHaveLength(3)
        expect((await state.storage.get<Row>(key))?.rawTransaction).toBe(row.rawTransaction)
        const before = parseTransaction(original.rawTransaction),
          after = parseTransaction(row.rawTransaction)
        expect(after).toMatchObject({
          nonce: before.nonce,
          to: before.to,
          data: before.data,
          gas: before.gas,
          chainId: before.chainId,
        })
        const priceField = type === "legacy" ? "gasPrice" : "maxFeePerGas"
        expect(after[priceField]).toBeGreaterThan(before[priceField]!)
        expect(after[priceField]).toBeLessThanOrEqual(before[priceField]! * 4n)
        if (type === "eip1559")
          expect(after.maxPriorityFeePerGas).toBeGreaterThan(before.maxPriorityFeePerGas!)
        await instance.recordReceipt(payment.payer, payment.nonce, original.txHash, {
          receiptObservedAt: Date.now(),
        })
        expect(await state.storage.get(key)).toMatchObject({
          state: "confirmed",
          txHash: original.txHash,
        })
      })
    },
  )

  it.each([false, true])(
    "waits for finalized failure and ignores stale recovery after confirmation (concurrent=%s)",
    async (concurrent) => {
      const object = stub(),
        payment = input(9)
      await runInDurableObject(object, async (instance, state) => {
        const key = `settle:${payment.payer}:${payment.nonce}`
        const hash = `0x${"b".repeat(64)}` as Hex,
          blockHash = `0x${"c".repeat(64)}` as Hex
        const row = {
          chainId: 137,
          payer: payment.payer,
          nonce: payment.nonce,
          txHash: hash,
          broadcastAt: Date.now(),
          state: "broadcast",
          input: payment,
        }
        await state.storage.put(key, row)
        let finalizedHeight = 9n
        const receipt = {
          status: "reverted",
          transactionHash: hash,
          blockNumber: 10n,
          blockHash,
          logs: [],
        }
        Object.defineProperty(instance, "clients", {
          value: () => ({
            public: {
              waitForTransactionReceipt: async () => receipt,
              getTransactionReceipt: async () => receipt,
              getBlock: async ({ blockTag }: { blockTag?: string }) => {
                if (blockTag === "finalized") {
                  if (concurrent)
                    await instance.recordReceipt(payment.payer, payment.nonce, hash, {
                      receiptObservedAt: Date.now(),
                    })
                  return { number: finalizedHeight, hash: blockHash, timestamp: 1n }
                }
                return { number: 10n, hash: blockHash, timestamp: 1n }
              },
            },
          }),
        })
        const check = Reflect.get(instance, "checkRecord").bind(instance)
        if (concurrent) finalizedHeight = 10n
        await check(key, row)
        expect(await state.storage.get(key)).toMatchObject({
          state: concurrent ? "confirmed" : "broadcast",
        })
        if (!concurrent) {
          finalizedHeight = 10n
          await check(key, row)
          expect(await state.storage.get(key)).toMatchObject({
            state: "reverted",
            notifyPending: true,
          })
        } else {
          expect((await state.storage.list({ prefix: "notify:" })).size).toBe(1)
          expect(await state.storage.get(key)).toMatchObject({ notifyPending: true })
        }
      })
    },
  )

  it("retries a failed signed merchant callback from durable storage", async () => {
    const object = stub(),
      payment = input(8)
    const send = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValue(new Response(null, { status: 204 }))
    await runInDurableObject(object, async (instance, state) => {
      Object.defineProperty(instance, "env", {
        value: {
          ...env,
          SETTLEMENT_NOTIFY_URL: "https://recovery.invalid/observed",
          SETTLEMENT_NOTIFY_SECRET: "test-only",
        },
      })
      const key = `settle:${payment.payer}:${payment.nonce}`
      await state.storage.put(key, {
        chainId: 137,
        payer: payment.payer,
        nonce: payment.nonce,
        txHash: `0x${"b".repeat(64)}`,
        broadcastAt: 1,
        state: "confirmed",
        notifyPending: true,
        nextCheck: 1,
      })
      await state.storage.put(`due:${"1".padStart(16, "0")}:${key}`, key)
      await instance.alarm()
      expect(await state.storage.get(key)).toMatchObject({
        state: "confirmed",
        notifyPending: true,
      })
      expect((await state.storage.list({ prefix: "notify:" })).size).toBe(1)
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 20_000)
      await instance.alarm()
      expect(await state.storage.get(key)).toMatchObject({
        state: "confirmed",
        notifyPending: false,
      })
      expect((await state.storage.list({ prefix: "notify:" })).size).toBe(0)
      const options = send.mock.calls[0]![1]!
      expect(options.redirect).toBe("manual")
      const body = options.body as string
      const cryptoKey = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode("test-only"),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      )
      const expected = [
        ...new Uint8Array(
          await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(body)),
        ),
      ]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")
      expect(new Headers(options.headers).get("X-Settlement-Signature")).toBe(expected)
    })
    send.mockRestore()
  })

  it("runs a persisted confirmation delivery without a browser request", async () => {
    const object = stub(),
      payment = input(4)
    await runInDurableObject(object, async (_, state) => {
      const key = `settle:${payment.payer}:${payment.nonce}`
      await state.storage.put(key, {
        chainId: 137,
        payer: payment.payer,
        nonce: payment.nonce,
        txHash: `0x${"b".repeat(64)}`,
        broadcastAt: 1,
        state: "confirmed",
        notifyPending: true,
        nextCheck: 1,
      })
      await state.storage.put(`due:${"1".padStart(16, "0")}:${key}`, key)
      await state.storage.setAlarm(Date.now() + 100)
    })
    expect(await runDurableObjectAlarm(object)).toBe(true)
    await runInDurableObject(object, async (_, state) => {
      expect((await state.storage.list({ prefix: "due:" })).size).toBe(0)
      expect(await state.storage.get(`settle:${payment.payer}:${payment.nonce}`)).toMatchObject({
        state: "confirmed",
        notifyPending: false,
      })
    })
  })
})
