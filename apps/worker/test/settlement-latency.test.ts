import "./durable-test-clock"
import { env, runInDurableObject } from "cloudflare:test"
import { describe, expect, it, vi } from "vitest"
import { keccak256, type Hex } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import type { DoBroadcastInput, DoBroadcastResult, RelayerSignerDO } from "../src/relayer-signer-do"
import type { WorkerEnv } from "../src/env"
import { authorizationFingerprint } from "../src/settlement-record"

const account = privateKeyToAccount(`0x${"1".repeat(64)}`)
const hash = `0x${"c".repeat(64)}` as Hex
function payment(n: number): DoBroadcastInput {
  return {
    chainId: 137,
    payer: account.address,
    payTo: `0x${"a".repeat(40)}`,
    valueAtomic: "1",
    validAfter: "0",
    validBefore: String(Math.floor(Date.now() / 1000) + 180),
    nonce: `0x${n.toString(16).padStart(64, "0")}`,
    signature: `0x${"d".repeat(128)}1b`,
  }
}
const keyFor = (input: DoBroadcastInput) => `settle:${input.payer.toLowerCase()}:${input.nonce}`
function stub() {
  const ns = (env as unknown as WorkerEnv).RELAYER
  return ns.get(ns.idFromName(crypto.randomUUID())) as DurableObjectStub<RelayerSignerDO>
}
function callbackEnv(instance: RelayerSignerDO) {
  Object.defineProperty(instance, "env", {
    value: {
      ...env,
      SETTLEMENT_NOTIFY_URL: "https://recovery.invalid/observed",
      SETTLEMENT_NOTIFY_SECRET: "test-only",
    },
  })
}

describe("settlement latency without weakening replay safety", () => {
  it("matches the EC signed-authorization fingerprint protocol fixture", () => {
    expect(
      authorizationFingerprint({
        chainId: 137,
        payer: `0x${"a".repeat(40)}`,
        payTo: `0x${"b".repeat(40)}`,
        valueAtomic: "1",
        validAfter: "0",
        validBefore: "2000000000",
        nonce: `0x${"c".repeat(64)}`,
        signature: `0x${"d".repeat(128)}1b`,
      }),
    ).toBe("0x9fba08f157c80f30dab65960926ef3af5d6583078816b8f7ae75800579b6a9ba")
  })
  it("delivers a confirmed payment while all receipt slots are blocked by other RPCs", async () => {
    await runInDurableObject(stub(), async (instance, state) => {
      callbackEnv(instance)
      let release!: () => void
      const blocked = new Promise<void>((resolve) => {
        release = resolve
      })
      let checking = 0
      const send = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(null, { status: 204 }))
      Object.defineProperty(instance, "clients", {
        value: () => ({
          public: {
            getTransactionReceipt: async () => {
              checking++
              await blocked
              throw new Error("not mined")
            },
          },
        }),
      })
      for (let i = 1; i <= 64; i++) {
        const input = payment(i),
          key = keyFor(input)
        await state.storage.put({
          [key]: {
            ...input,
            input,
            txHash: hash,
            broadcastAt: Date.now(),
            state: "broadcast",
            nextCheck: 1,
          },
          [`due:${"1".padStart(16, "0")}:${key}`]: key,
        })
      }
      const settled = payment(100),
        key = keyFor(settled)
      await state.storage.put(key, {
        ...settled,
        input: settled,
        txHash: hash,
        broadcastAt: Date.now(),
        state: "broadcast",
      })
      const alarm = instance.alarm()
      try {
        await vi.waitFor(() => expect(checking).toBe(8))
        await instance.recordReceipt(settled.payer, settled.nonce, hash, {
          receiptObservedAt: Date.now(),
        })
        await vi.waitFor(async () => {
          expect(send).toHaveBeenCalledTimes(1)
          expect(await state.storage.get(key)).toMatchObject({
            state: "confirmed",
            notifyPending: false,
          })
        })
        expect(checking).toBe(8)
      } finally {
        release()
        await alarm
      }
      expect(checking).toBe(64)
    })
  })

  it("delivers 64 durable notifications with at most eight concurrent requests", async () => {
    await runInDurableObject(stub(), async (instance, state) => {
      callbackEnv(instance)
      let active = 0,
        peak = 0
      const send = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
        peak = Math.max(peak, ++active)
        await new Promise((resolve) => setTimeout(resolve, 5))
        active--
        return new Response(null, { status: 204 })
      })
      for (let i = 1; i <= 64; i++) {
        const input = payment(i),
          key = keyFor(input)
        await state.storage.put({
          [key]: {
            ...input,
            txHash: hash,
            broadcastAt: 1,
            state: "confirmed",
            notifyPending: true,
            nextCheck: 1,
          },
          [`notify:${"1".padStart(16, "0")}:${key}`]: key,
        })
      }
      await instance.alarm()
      expect(send).toHaveBeenCalledTimes(64)
      expect(peak).toBeGreaterThan(1)
      expect(peak).toBeLessThanOrEqual(8)
      expect((await state.storage.list({ prefix: "notify:" })).size).toBe(0)
      const rows = await state.storage.list<{ notifyPending: boolean; timeline: object }>({
        prefix: "settle:",
      })
      for (const row of rows.values()) {
        expect(row.notifyPending).toBe(false)
        expect(row.timeline).toHaveProperty("notificationStartedAt")
        expect(row.timeline).toHaveProperty("notificationAcknowledgedAt")
      }
    })
  })

  it("persists a preparation rejection and fences a delayed concurrent preparation", async () => {
    const object = stub(),
      input = payment(200)
    await runInDurableObject(object, async (instance, state) => {
      let release!: () => void, started!: () => void
      const blocked = new Promise<void>((resolve) => {
        release = resolve
      })
      const entered = new Promise<void>((resolve) => {
        started = resolve
      })
      let prepares = 0
      const send = vi.fn()
      Object.defineProperty(instance, "getAccount", { value: () => account })
      Object.defineProperty(instance, "clients", {
        value: () => ({
          wallet: {
            prepareTransactionRequest: async () => {
              if (++prepares === 1) {
                started()
                await blocked
                return { type: "legacy", gas: 100_000n, gasPrice: 1n }
              }
              throw new Error("RPC unavailable")
            },
          },
          public: { getTransactionCount: async () => 0, sendRawTransaction: send },
        }),
      })
      const prepare = Reflect.get(instance, "prepareAndBroadcast").bind(instance) as (
        key: string,
        input: DoBroadcastInput,
      ) => Promise<DoBroadcastResult>
      const late = prepare(keyFor(input), input)
      await entered
      const first = await prepare(keyFor(input), input)
      expect(first).toMatchObject({
        ok: false,
        submissionRejection: {
          version: 1,
          state: "not_submitted",
          authorizationHash: authorizationFingerprint(input),
        },
      })
      release()
      expect(await late).toMatchObject({
        ok: false,
        submissionRejection: { state: "not_submitted" },
      })
      expect(await instance.broadcast(input)).toMatchObject({
        ok: false,
        submissionRejection: { state: "not_submitted" },
      })
      expect(send).not.toHaveBeenCalled()
      expect((await state.storage.list({ prefix: "next-nonce:" })).size).toBe(0)
      expect(await instance.getSettleRecord(input.payer, input.nonce)).toBeNull()
    })
    expect(await object.getSubmissionRejection(input.payer, input.nonce)).toMatchObject({
      state: "not_submitted",
      authorizationHash: authorizationFingerprint(input),
    })
  })

  it("does not issue an unsubmitted proof after a send response is lost", async () => {
    await runInDurableObject(stub(), async (instance) => {
      const input = payment(201)
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
            getTransactionCount: async () => 0,
            sendRawTransaction: async ({
              serializedTransaction,
            }: {
              serializedTransaction: Hex
            }) => {
              expect(keccak256(serializedTransaction)).toMatch(/^0x/)
              throw new Error("response lost after accepting transaction")
            },
          },
        }),
      })
      expect(await instance.broadcast(input)).toMatchObject({ ok: true })
      expect(await instance.getSubmissionRejection(input.payer, input.nonce)).toBeNull()
      expect(await instance.getSettleRecord(input.payer, input.nonce)).toHaveProperty("txHash")
    })
  })
})
