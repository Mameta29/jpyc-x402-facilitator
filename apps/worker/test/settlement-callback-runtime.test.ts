import "./durable-test-clock"
import { env, fetchMock, runInDurableObject } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import type { WorkerEnv } from "../src/env"
import type { RelayerSignerDO } from "../src/relayer-signer-do"

describe("merchant callback through native workerd fetch", () => {
  it.each([204, 307, 503])("handles HTTP %s through native fetch and only acknowledges success", async (status) => {
    fetchMock.activate()
    fetchMock.disableNetConnect()
    fetchMock.get("https://recovery.invalid")
      .intercept({ path: "/observed", method: "POST" })
      .reply(status, "", status === 307 ? { headers: { location: "https://untrusted.invalid/redirected" } } : undefined)
    try {
      const ns = (env as unknown as WorkerEnv).RELAYER
      const object = ns.get(ns.idFromName(crypto.randomUUID())) as unknown as DurableObjectStub<RelayerSignerDO>
      await runInDurableObject(object, async (instance, state) => {
        Object.defineProperty(instance, "env", { value: {
          ...env, SETTLEMENT_NOTIFY_URL: "https://recovery.invalid/observed", SETTLEMENT_NOTIFY_SECRET: "test-only",
        } })
        const key = "settle:callback-runtime"
        await state.storage.put(key, {
          chainId: 11155111, payer: `0x${"a".repeat(40)}`, nonce: `0x${"b".repeat(64)}`,
          txHash: `0x${"c".repeat(64)}`, broadcastAt: 1, state: "confirmed", notifyPending: true, nextCheck: 1,
        })
        await state.storage.put(`due:${"1".padStart(16, "0")}:${key}`, key)
        await instance.alarm()
        expect(await state.storage.get(key)).toMatchObject({ state: "confirmed", notifyPending: status !== 204 })
        expect((await state.storage.list({ prefix: "due:" })).size).toBe(status === 204 ? 0 : 1)
        await state.storage.deleteAll()
      })
      fetchMock.assertNoPendingInterceptors()
    } finally {
      fetchMock.deactivate()
    }
  })
})
