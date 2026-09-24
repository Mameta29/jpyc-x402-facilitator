import { env, runInDurableObject } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import type { WorkerEnv } from "../src/env"
import type { DoBroadcastInput, RelayerSignerDO, SettleRecord } from "../src/relayer-signer-do"
import { authorizationFingerprint } from "../src/settlement-record"

const input: DoBroadcastInput = {
  chainId: 137,
  payer: `0x${"a".repeat(40)}`,
  payTo: `0x${"b".repeat(40)}`,
  valueAtomic: "0",
  validAfter: "0",
  validBefore: "1000",
  nonce: `0x${"c".repeat(64)}`,
  signature: `0x${"d".repeat(128)}1b`,
}
const txHash = `0x${"e".repeat(64)}` as const

describe("durable settlement records", () => {
  async function setup() {
    const ns = (env as unknown as WorkerEnv).RELAYER
    const stub = ns.get(
      ns.idFromName(crypto.randomUUID()),
    ) as unknown as DurableObjectStub<RelayerSignerDO>
    const record: SettleRecord = {
      txHash,
      broadcastAt: 200,
      chainId: 137,
      payer: input.payer,
      nonce: input.nonce,
      authorizationHash: authorizationFingerprint(input),
      timeline: { queueEnteredAt: 100, broadcastStartedAt: 150, broadcastAt: 200 },
    }
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put(`settle:${input.payer}:${input.nonce}`, record)
    })
    return stub
  }
  it("replays the same expired authorization without broadcasting, even for concurrent requests", async () => {
    const stub = await setup()
    const results = await Promise.all([stub.broadcast(input), stub.broadcast(input)])
    for (const result of results) expect(result).toMatchObject({ ok: true, replayed: true, txHash })
    expect(await stub.getSettleRecord(input.payer, input.nonce)).toMatchObject({ txHash })
  })
  it("refuses reuse of the nonce with a different authorized amount", async () => {
    const stub = await setup()
    expect(await stub.broadcast({ ...input, valueAtomic: "1" })).toMatchObject({
      ok: false,
      reason: "authorization_record_mismatch",
    })
  })
  it("persists receipt observations without overwriting broadcast timing or the first receipt", async () => {
    const stub = await setup()
    await stub.recordReceipt(input.payer, input.nonce, txHash, {
      receiptObservedAt: 300,
      blockTimestamp: 250,
    })
    await stub.recordReceipt(input.payer, input.nonce, txHash, {
      receiptObservedAt: 500,
      blockTimestamp: 450,
    })
    expect((await stub.getSettleRecord(input.payer, input.nonce))?.timeline).toEqual({
      queueEnteredAt: 100,
      broadcastStartedAt: 150,
      broadcastAt: 200,
      receiptObservedAt: 300,
      blockTimestamp: 250,
    })
  })
  it("does not record a receipt for a different transaction", async () => {
    const stub = await setup()
    await stub.recordReceipt(input.payer, input.nonce, input.nonce, { receiptObservedAt: 300 })
    expect(
      (await stub.getSettleRecord(input.payer, input.nonce))?.timeline?.receiptObservedAt,
    ).toBeUndefined()
  })
})
