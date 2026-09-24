import { env, listDurableObjectIds, runInDurableObject } from "cloudflare:test"
import { beforeEach, afterEach, vi } from "vitest"
import type { WorkerEnv } from "../src/env"
import type { RelayerSignerDO } from "../src/relayer-signer-do"
// The old pool's isolated SQLite snapshots cannot race real alarm callbacks.
// Schedule against a future clock; tests explicitly run the alarm and drain
// storage before ending. Storage/transactions still run in real workerd.
beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 3_600_000)
})
afterEach(async () => {
  const ns = (env as unknown as WorkerEnv).RELAYER
  for (const id of await listDurableObjectIds(ns)) {
    const stub = ns.get(id) as unknown as DurableObjectStub<RelayerSignerDO>
    await runInDurableObject(stub, async (_, state) => {
      await state.storage.deleteAlarm()
      await state.storage.deleteAll()
    })
  }
  vi.restoreAllMocks()
})
