/** One exclusive relayer account per chain. Only local signing + durable
 * nonce allocation serialize; RPC, receipts and merchant callbacks do not.
 * A raw transaction and its hash MUST commit before any broadcast. */
import { DurableObject } from "cloudflare:workers"
import {
  type Address,
  type Hex,
  createWalletClient,
  createPublicClient,
  encodeFunctionData,
  keccak256,
  parseTransaction,
  fallback,
  http,
} from "viem"
import { privateKeyToAccount } from "viem/accounts"
import {
  JPYC_ABI,
  checkTimeWindow,
  submissionMarginSeconds,
  splitSignatureComponents,
  resolveViemChain,
  parseEip3009RevertReason,
} from "@jpyc-x402/evm"
import { getJpycChain } from "@jpyc-x402/shared"
import { waitAndVerifyTransfer, type SettlementTimeline } from "@jpyc-x402/facilitator"
import type { WorkerEnv } from "./env"
import { authorizationFingerprint } from "./settlement-record"
import { LegacyRelayerSigner } from "./legacy-relayer-signer"
import { relayerChainKeys, usesDurableSettlement } from "./relayer-config"

export interface DoBroadcastInput {
  chainId: number
  payer: Address
  payTo: Address
  /** Atomic units, decimal string (DO RPC strips bigint serialization). */
  valueAtomic: string
  validAfter: string
  validBefore: string
  nonce: Hex
  signature: Hex
  timeline?: SettlementTimeline
}

export interface DoBroadcastOk {
  ok: true
  txHash: Hex
  /**
   * true when this (payer, nonce) was already broadcast by a previous request
   * and the stored txHash is being replayed instead of re-broadcasting.
   * Cross-isolate safe: the record lives in DO storage, not isolate memory.
   */
  replayed?: boolean
  timeline?: SettlementTimeline
}
export interface DoBroadcastFail {
  ok: false
  reason: string
}
export type DoBroadcastResult = DoBroadcastOk | DoBroadcastFail

/**
 * Persistent record of a broadcast, kept in DO storage. This is the
 * cross-isolate idempotency layer the in-memory NonceCache cannot provide:
 * a retry landing on a different isolate (or after an isolate restart) still
 * finds the txHash here instead of double-broadcasting / returning a bogus
 * failure for an already-settled payment.
 *
 * Unresolved records are never pruned. Terminal records retain their hashes
 * for safe replay; the due index keeps recovery independent of history size.
 */
export interface SettleRecord {
  txHash: Hex
  broadcastAt: number
  chainId: number
  payer: string
  nonce: string
  authorizationHash?: string
  timeline?: SettlementTimeline
}

interface DurableSettleRecord extends SettleRecord {
  rawTransaction?: Hex
  input?: DoBroadcastInput
  relayerNonce?: number
  signer?: Address
  state?: "prepared" | "broadcast" | "confirmed" | "reverted"
  nextCheck?: number
  checks?: number
  notifyPending?: boolean
  lastError?: string
  previousTransactions?: { txHash: Hex; rawTransaction: Hex }[]
  replacedAt?: number
}
const recordKey = (payer: string, nonce: string) =>
  `settle:${payer.toLowerCase()}:${nonce.toLowerCase()}`
const dueKey = (at: number, key: string) => `due:${String(at).padStart(16, "0")}:${key}`

export class RelayerSignerDO extends DurableObject<WorkerEnv> {
  private accounts = new Map<number, ReturnType<typeof privateKeyToAccount>>()
  private legacy?: LegacyRelayerSigner
  private inFlight = new Map<string, Promise<DoBroadcastResult>>()
  private getAccount(chainId: number) {
    let account = this.accounts.get(chainId)
    if (!account) {
      account = privateKeyToAccount(relayerChainKeys(this.env)[chainId] ?? this.env.RELAYER_PRIVATE_KEY as Hex)
      this.accounts.set(chainId, account)
    }
    return account
  }
  private clients(chainId: number) {
    const chain = getJpycChain(chainId)
    const transport = fallback(
      readRpcUrls(this.env, chainId, chain.publicRpc).map((url) =>
        http(url, { timeout: 4_000, retryCount: 0 }),
      ),
      { rank: false, retryCount: 0 },
    )
    return {
      public: createPublicClient({ chain: resolveViemChain(chainId), transport }),
      wallet: createWalletClient({
        account: this.getAccount(chainId),
        chain: resolveViemChain(chainId),
        transport,
      }),
    }
  }

  /** Never expose raw transactions or signatures through status RPCs. */
  async getSettleRecord(payer: string, nonce: string): Promise<SettleRecord | null> {
    const record = await this.ctx.storage.get<DurableSettleRecord>(recordKey(payer, nonce))
    if (!record) return null
    return {
      txHash: record.txHash,
      broadcastAt: record.broadcastAt,
      chainId: record.chainId,
      payer: record.payer,
      nonce: record.nonce,
      authorizationHash: record.authorizationHash,
      timeline: record.timeline,
    }
  }

  private async schedule(
    key: string,
    update: Partial<DurableSettleRecord>,
    delayMs: number | null,
    observed?: DurableSettleRecord,
  ) {
    await this.ctx.storage.transaction(async (txn) => {
      const row = await txn.get<DurableSettleRecord>(key)
      if (!row) return
      // An RPC result or callback acknowledgement can arrive after another
      // observer confirmed the payment. Only update the observation we read.
      if (
        observed &&
        (row.state !== observed.state ||
          row.txHash !== observed.txHash ||
          row.timeline?.receiptObservedAt !== observed.timeline?.receiptObservedAt)
      )
        return
      if (row.state === "confirmed" && update.state && update.state !== "confirmed") return
      if (row.nextCheck) await txn.delete(dueKey(row.nextCheck, key))
      const nextCheck = delayMs === null ? undefined : Date.now() + delayMs
      await txn.put(key, { ...row, ...update, nextCheck })
      if (nextCheck !== undefined) {
        await txn.put(dueKey(nextCheck, key), key)
        const alarm = await txn.getAlarm()
        if (alarm === null || nextCheck < alarm) await txn.setAlarm(nextCheck)
      }
    })
  }

  async recordReceipt(
    payer: string,
    nonce: string,
    txHash: string,
    observation: { receiptObservedAt: number; blockTimestamp?: number },
  ) {
    const key = recordKey(payer, nonce)
    const record = await this.ctx.storage.get<DurableSettleRecord>(key)
    if (record && !usesDurableSettlement(this.env, record.chainId)) return
    if (
      !record ||
      ![record.txHash, ...(record.previousTransactions ?? []).map((tx) => tx.txHash)].some(
        (hash) => hash.toLowerCase() === txHash.toLowerCase(),
      )
    )
      return
    if (record.state === "confirmed" && record.txHash.toLowerCase() === txHash.toLowerCase()) return
    await this.schedule(
      key,
      {
        txHash: txHash as Hex,
        state: "confirmed",
        notifyPending: true,
        timeline: { ...observation, ...record.timeline },
      },
      1,
    )
  }

  async broadcast(input: DoBroadcastInput): Promise<DoBroadcastResult> {
    if (!usesDurableSettlement(this.env, input.chainId)) {
      this.legacy ??= new LegacyRelayerSigner(this.ctx, this.env)
      return this.legacy.broadcast(input)
    }
    const key = recordKey(input.payer, input.nonce)
    // Coalescing is only an optimization. Durable transaction below is the
    // authoritative gate, including after a process restart.
    const flightKey = `${key}:${authorizationFingerprint(input)}`
    const pending = this.inFlight.get(flightKey)
    if (pending) return pending
    const work = this.prepareAndBroadcast(key, input)
    this.inFlight.set(flightKey, work)
    try {
      return await work
    } finally {
      this.inFlight.delete(flightKey)
    }
  }

  private async prepareAndBroadcast(
    key: string,
    input: DoBroadcastInput,
  ): Promise<DoBroadcastResult> {
    try {
      const fingerprint = authorizationFingerprint(input)
      let record = await this.ctx.storage.get<DurableSettleRecord>(key)
      if (record) {
        if (record.authorizationHash && record.authorizationHash !== fingerprint)
          return { ok: false, reason: "authorization_record_mismatch" }
        // Legacy records are retained and remain readable during rolling deploy.
        if (record.rawTransaction && !["confirmed", "reverted"].includes(record.state ?? ""))
          await this.sendRecorded(key, record)
        const observed = await this.ctx.storage.get<DurableSettleRecord>(key) ?? record
        return { ok: true, txHash: observed.txHash, replayed: true, timeline: observed.timeline }
      }
      const timeError = checkTimeWindow(
        BigInt(input.validAfter),
        BigInt(input.validBefore),
        BigInt(Math.floor(Date.now() / 1000)),
        undefined,
        submissionMarginSeconds(input.chainId),
      )
      if (timeError) return { ok: false, reason: timeError }
      const { public: publicClient, wallet } = this.clients(input.chainId)
      const account = this.getAccount(input.chainId)
      const chain = getJpycChain(input.chainId)
      const { v, r, s } = splitSignatureComponents(input.signature)
      const data = encodeFunctionData({
        abi: JPYC_ABI,
        functionName: "transferWithAuthorization",
        args: [
          input.payer,
          input.payTo,
          BigInt(input.valueAtomic),
          BigInt(input.validAfter),
          BigInt(input.validBefore),
          input.nonce,
          v,
          r,
          s,
        ],
      })
      // No network I/O in the storage transaction. Nonce is deliberately NOT
      // prepared by viem: the durable lane assigns it once gas/fees are known.
      const [prepared, pendingNonce, minedNonce] = await Promise.all([
        wallet.prepareTransactionRequest({
          account,
          to: chain.jpycAddress,
          data,
          parameters: ["gas", "fees", "type"],
          nonce: 0,
        }),
        publicClient.getTransactionCount({ address: account.address, blockTag: "pending" }),
        publicClient.getTransactionCount({ address: account.address, blockTag: "latest" }),
      ])
      record = await this.ctx.storage.transaction(async (txn) => {
        const previous = await txn.get<DurableSettleRecord>(key)
        if (previous) {
          if (previous.authorizationHash !== fingerprint)
            throw new Error("authorization_record_mismatch")
          return previous
        }
        const timeError = checkTimeWindow(
          BigInt(input.validAfter),
          BigInt(input.validBefore),
          BigInt(Math.floor(Date.now() / 1000)),
          undefined,
          submissionMarginSeconds(input.chainId),
        )
        if (timeError) throw new Error(timeError)
        const nonceKey = `next-nonce:${input.chainId}:${account.address.toLowerCase()}`
        const storedNonce = await txn.get<number>(nonceKey)
        const nonce = Math.max(storedNonce ?? 0, pendingNonce)
        // Bound a chain's unmined backlog. Do not allocate another nonce or
        // strand a fresh signature behind an arbitrarily long queue. The EC
        // journal can retry the same approval after capacity becomes available.
        if (nonce - minedNonce >= 128) throw new Error("relayer_capacity_reached")
        // Local secp256k1 signing only. A failed commit allocates no nonce and
        // emits no transaction; retries re-enter this atomic allocation.
        const base = {
          chainId: input.chainId,
          nonce,
          to: chain.jpycAddress,
          data,
          gas: prepared.gas,
        }
        const rawTransaction = await account.signTransaction(
          prepared.type === "eip1559"
            ? {
                ...base,
                type: "eip1559",
                maxFeePerGas: prepared.maxFeePerGas!,
                maxPriorityFeePerGas: prepared.maxPriorityFeePerGas!,
              }
            : { ...base, type: "legacy", gasPrice: prepared.gasPrice! },
        )
        const now = Date.now()
        const row: DurableSettleRecord = {
          txHash: keccak256(rawTransaction),
          rawTransaction,
          input,
          relayerNonce: nonce,
          signer: account.address,
          chainId: input.chainId,
          payer: input.payer.toLowerCase(),
          nonce: input.nonce.toLowerCase(),
          authorizationHash: fingerprint,
          broadcastAt: now,
          state: "prepared",
          nextCheck: now + 1_000,
          timeline: { ...input.timeline, broadcastStartedAt: now },
        }
        await txn.put({ [key]: row, [nonceKey]: nonce + 1, [dueKey(row.nextCheck!, key)]: key })
        const alarm = await txn.getAlarm()
        if (alarm === null || row.nextCheck! < alarm) await txn.setAlarm(row.nextCheck!)
        return row
      })
      await this.sendRecorded(key, record)
      const observed = await this.ctx.storage.get<DurableSettleRecord>(key) ?? record
      return { ok: true, txHash: observed.txHash, timeline: observed.timeline }
    } catch (error) {
      // Never return RPC error text: it can include credentials or signatures.
      const reason =
        error instanceof Error && error.message === "relayer_capacity_reached"
          ? error.message
          : (parseEip3009RevertReason(error) ?? "broadcast_preparation_failed")
      console.error(JSON.stringify({ ev: "broadcast.error", chainId: input.chainId, reason }))
      return { ok: false, reason }
    }
  }

  private async sendRecorded(key: string, record: DurableSettleRecord) {
    if (!record.rawTransaction) return
    try {
      const hash = await this.clients(record.chainId).public.sendRawTransaction({
        serializedTransaction: record.rawTransaction,
      })
      if (hash.toLowerCase() !== record.txHash.toLowerCase())
        throw new Error("broadcast_hash_mismatch")
      // A concurrent receipt observer must never be regressed to broadcast.
      await this.ctx.storage.transaction(async (txn) => {
        const latest = await txn.get<DurableSettleRecord>(key)
        if (!latest || latest.state !== "prepared") return
        await txn.put(key, {
          ...latest,
          state: "broadcast",
          timeline: { ...latest.timeline, broadcastAt: Date.now() },
        })
      })
    } catch {
      // "already known", timeout, nonce too low and RPC outage are all
      // ambiguous. The durable raw tx + alarm already exist; keep observing.
      console.warn(
        JSON.stringify({
          ev: "broadcast.awaiting_observation",
          chainId: record.chainId,
          txHash: record.txHash,
        }),
      )
    }
  }

  override async alarm() {
    // Indexed due queue, bounded work. Never scan every historical payment.
    const due = await this.ctx.storage.list<string>({
      prefix: "due:",
      end: `due:${String(Date.now() + 1).padStart(16, "0")}`,
      limit: 24,
    })
    const entries = [...due.entries()]
    let next = 0
    await Promise.all(
      Array.from({ length: Math.min(4, entries.length) }, async () => {
        while (next < entries.length) {
          const [due, key] = entries[next++]!
          const row = await this.ctx.storage.get<DurableSettleRecord>(key)
          if (!row || !row.nextCheck || dueKey(row.nextCheck, key) !== due) {
            await this.ctx.storage.delete(due)
            continue
          }
          // Advance the durable cursor BEFORE external I/O. A crash retries from
          // this point and never loses the obligation to check/notify.
          await this.schedule(key, { checks: (row.checks ?? 0) + 1 }, 5_000, row)
          try {
            await this.checkRecord(key, row)
          } catch {
            await this.schedule(key, { lastError: "recovery_unavailable" }, 15_000, row)
          }
        }
      }),
    )
    await this.ctx.storage.transaction(async (txn) => {
      const first = [...(await txn.list<string>({ prefix: "due:", limit: 1 })).keys()][0]
      if (first) await txn.setAlarm(Math.max(Date.now() + 100, Number(first.split(":")[1])))
    })
  }

  private async checkRecord(key: string, row: DurableSettleRecord) {
    if (row.state === "confirmed" || row.state === "reverted") {
      if (row.notifyPending) await this.notify(row)
      await this.schedule(key, { notifyPending: false }, null, row)
      return
    }
    if (!row.input) {
      await this.schedule(key, {}, null, row)
      return
    }
    const client = this.clients(row.chainId).public
    const expected = {
      payer: row.input.payer,
      payTo: row.input.payTo,
      valueAtomic: BigInt(row.input.valueAtomic),
      nonce: row.input.nonce,
    }
    for (const hash of [row.txHash, ...(row.previousTransactions ?? []).map((tx) => tx.txHash)]) {
      const result = await waitAndVerifyTransfer(client, row.chainId, hash, expected, {
        receiptTimeoutMs: 1_000,
      })
      if (result.ok) {
        await this.recordReceipt(row.payer, row.nonce, hash, {
          receiptObservedAt: Date.now(),
          blockTimestamp: result.blockTimestamp.getTime(),
        })
        return
      }
      if (result.reason === "tx reverted on-chain") {
        // A head receipt can be orphaned. Keep the durable observation alive
        // until a canonical finalized block contains the revert. Kaia's BFT
        // latest block is final; other chains must support `finalized`.
        const [receipt, finalized] = await Promise.all([
          client.getTransactionReceipt({ hash }),
          client.getBlock({
            blockTag: row.chainId === 8217 || row.chainId === 1001 ? "latest" : "finalized",
          }),
        ])
        if (
          receipt.status === "reverted" &&
          receipt.transactionHash.toLowerCase() === hash.toLowerCase() &&
          finalized.number !== null &&
          receipt.blockNumber <= finalized.number
        ) {
          const canonical = await client.getBlock({ blockNumber: receipt.blockNumber })
          if (canonical.hash?.toLowerCase() === receipt.blockHash.toLowerCase()) {
            await this.schedule(
              key,
              { txHash: hash, state: "reverted", notifyPending: true },
              1,
              row,
            )
          }
        }
        return
      }
    }
    if (Date.now() - (row.replacedAt ?? row.broadcastAt) >= 45_000)
      row = await this.bumpFees(key, row)
    await this.sendRecorded(key, row)
    const age = Date.now() - row.broadcastAt
    if (age > 5 * 60_000)
      console.error(
        JSON.stringify({
          ev: "settlement.needs_attention",
          chainId: row.chainId,
          txHash: row.txHash,
        }),
      )
    await this.schedule(key, {}, age > 3_600_000 ? 300_000 : age > 300_000 ? 30_000 : 5_000, row)
  }

  /** Same relayer nonce, same calldata, same amount. Only fees change. This
   * unblocks a low-fee head transaction without creating a second payment.
   * At most three replacements, capped at 4x the initial per-gas budget. */
  private async bumpFees(key: string, row: DurableSettleRecord): Promise<DurableSettleRecord> {
    if (
      !row.rawTransaction ||
      !row.signer ||
      row.signer.toLowerCase() !== this.getAccount(row.chainId).address.toLowerCase() ||
      (row.previousTransactions?.length ?? 0) >= 3
    )
      return row
    const tx = parseTransaction(row.rawTransaction)
    const original = parseTransaction(
      row.previousTransactions?.[0]?.rawTransaction ?? row.rawTransaction,
    )
    const base = {
      chainId: row.chainId,
      nonce: row.relayerNonce!,
      to: tx.to,
      data: tx.data,
      gas: tx.gas,
      value: tx.value,
    }
    const bump = (value: bigint) => (value * 9n) / 8n + 1n
    let rawTransaction: Hex
    if (tx.type === "eip1559" && original.type === "eip1559") {
      const fees = await this.clients(row.chainId).public.estimateFeesPerGas({ type: "eip1559" })
      const maxPriorityFeePerGas =
        fees.maxPriorityFeePerGas > bump(tx.maxPriorityFeePerGas!)
          ? fees.maxPriorityFeePerGas
          : bump(tx.maxPriorityFeePerGas!)
      const maxFeePerGas =
        fees.maxFeePerGas > bump(tx.maxFeePerGas!) ? fees.maxFeePerGas : bump(tx.maxFeePerGas!)
      if (maxFeePerGas > original.maxFeePerGas! * 4n || maxPriorityFeePerGas > maxFeePerGas)
        return row
      rawTransaction = await this.getAccount(row.chainId).signTransaction({
        ...base,
        type: "eip1559",
        maxPriorityFeePerGas,
        maxFeePerGas,
      })
    } else if (tx.type === "legacy" && original.type === "legacy") {
      const estimate = await this.clients(row.chainId).public.getGasPrice()
      const gasPrice = estimate > bump(tx.gasPrice!) ? estimate : bump(tx.gasPrice!)
      if (gasPrice > original.gasPrice! * 4n) return row
      rawTransaction = await this.getAccount(row.chainId).signTransaction({
        ...base,
        type: "legacy",
        gasPrice,
      })
    } else return row
    return this.ctx.storage.transaction(async (txn) => {
      const current = await txn.get<DurableSettleRecord>(key)
      if (
        !current ||
        current.txHash !== row.txHash ||
        ["confirmed", "reverted"].includes(current.state ?? "")
      )
        return current ?? row
      const updated = {
        ...current,
        txHash: keccak256(rawTransaction),
        rawTransaction,
        state: "prepared" as const,
        previousTransactions: [
          ...(current.previousTransactions ?? []),
          { txHash: current.txHash, rawTransaction: current.rawTransaction! },
        ],
        replacedAt: Date.now(),
      }
      // Persistence before broadcast also applies to fee replacements.
      await txn.put(key, updated)
      return updated
    })
  }

  private async notify(row: DurableSettleRecord) {
    if (!this.env.SETTLEMENT_NOTIFY_URL || !this.env.SETTLEMENT_NOTIFY_SECRET) {
      console.warn(JSON.stringify({ ev: "settlement.notify_disabled", chainId: row.chainId,
        hasUrl: Boolean(this.env.SETTLEMENT_NOTIFY_URL), hasSecret: Boolean(this.env.SETTLEMENT_NOTIFY_SECRET) }))
      return
    }
    const url = new URL(this.env.SETTLEMENT_NOTIFY_URL)
    if (url.protocol !== "https:") throw new Error("invalid_recovery_callback")
    const body = JSON.stringify({
      chainId: row.chainId,
      payer: row.payer,
      nonce: row.nonce,
      txHash: row.txHash,
      timestamp: Date.now(),
    })
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(this.env.SETTLEMENT_NOTIFY_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    )
    const signature = [
      ...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))),
    ]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")
    const startedAt = Date.now()
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Settlement-Signature": signature },
      body,
      signal: AbortSignal.timeout(10_000),
      // workerd rejects redirect:"error" before making any request. Manual
      // keeps the signed body on this fixed origin; 3xx remains a failed delivery.
      redirect: "manual",
    }).catch((error: unknown) => {
      const detail = error instanceof Error ? error.message
        .replace(/https?:\/\/\S+/g, "[url]")
        .replace(/\b(?:0x)?[a-fA-F0-9]{64,}\b/g, "[redacted]")
        .slice(0, 240) : "unknown_fetch_error"
      console.warn(JSON.stringify({ ev: "settlement.notify_failed", chainId: row.chainId,
        txHash: row.txHash, durationMs: Date.now() - startedAt, reason: "network_or_timeout", detail }))
      throw new Error("recovery_callback_failed")
    })
    console.info(JSON.stringify({ ev: "settlement.notify_result", chainId: row.chainId,
      txHash: row.txHash, status: response.status, durationMs: Date.now() - startedAt }))
    if (!response.ok) throw new Error("recovery_callback_failed")
  }
}

function readRpcUrls(env: WorkerEnv, chainId: number, fallbackUrl: string): string[] {
  const key = `RPC_URLS_${chainId}` as keyof WorkerEnv
  const raw = env[key]
  if (typeof raw === "string" && raw.length > 0) {
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  }
  return [fallbackUrl]
}
