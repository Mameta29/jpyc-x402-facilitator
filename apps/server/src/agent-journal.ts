import type { DatabaseSync as SqliteDatabase } from "node:sqlite"
import { createRequire } from "node:module"
import { mkdirSync, chmodSync } from "node:fs"
import { dirname } from "node:path"
import { paymentKeyId } from "@jpyc-ec/agent-commerce"
import { AgentPaymentError, type PreparedPurchase } from "@jpyc-x402/evm"
import type { Hex } from "viem"

// Keep this Node-only built-in out of Vite's older builtin resolver.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite")

export type UnsignedPurchase = { chainId: number; to: Hex; data: Hex; value: "0"; gas: string; maxFeePerGas: string; maxPriorityFeePerGas: string; nonce: number }
export type JobState = "reserved" | "prepared" | "broadcast" | "confirmed" | "reverted" | "unknown" | "expired_unpaid"
export type Job = { payment_key: string; request_id: string; intent_hash: Hex; prepared: string; unsigned_tx: string; raw_tx: Hex | null; tx_hash: Hex | null; state: JobState; receipt: string | null; finalized: number; last_error: string | null }

/** WAL + FULL sync. Stores signed bytes before broadcasting, on durable storage. */
export class AgentJournal {
  readonly db: SqliteDatabase
  constructor(path: string) {
    if (path === ":memory:") throw new Error("Agent settlement requires a durable journal")
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    chmodSync(path, 0o600)
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS agent_sender_state (lane TEXT PRIMARY KEY, next_nonce INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_payment_jobs (
        payment_key TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, intent_hash TEXT NOT NULL,
        lane TEXT NOT NULL, nonce INTEGER NOT NULL, prepared TEXT NOT NULL, unsigned_tx TEXT NOT NULL,
        raw_tx TEXT, tx_hash TEXT UNIQUE, state TEXT NOT NULL CHECK(state IN ('reserved','prepared','broadcast','confirmed','reverted','unknown','expired_unpaid')),
        receipt TEXT, finalized INTEGER NOT NULL DEFAULT 0, last_error TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(lane,nonce)
      );`)
  }
  get(key: string): Job | undefined { return this.db.prepare("SELECT * FROM agent_payment_jobs WHERE payment_key=?").get(key) as Job | undefined }
  findRequest(id: string): Job | undefined { return this.db.prepare("SELECT * FROM agent_payment_jobs WHERE request_id=?").get(id) as Job | undefined }
  reserve(prepared: PreparedPurchase, requestId: string, sender: string, pendingNonce: number, unsigned: Omit<UnsignedPurchase, "nonce">): Job {
    const key = paymentKeyId(prepared.paymentKey), lane = `${prepared.chainId}:${sender.toLowerCase()}`
    this.db.exec("BEGIN IMMEDIATE")
    try {
      const existing = this.get(key)
      if (existing) {
        if (existing.intent_hash !== prepared.intentHash || existing.request_id !== requestId) throw new AgentPaymentError("payment_key_conflict", 409)
        this.db.exec("COMMIT"); return existing
      }
      const laneState = this.db.prepare("SELECT next_nonce FROM agent_sender_state WHERE lane=?").get(lane) as { next_nonce: number } | undefined
      const nonce = Math.max(pendingNonce, laneState?.next_nonce ?? 0)
      if (!Number.isSafeInteger(nonce) || nonce < 0) throw new AgentPaymentError("invalid_relayer_nonce")
      const now = Math.floor(Date.now()/1000)
      if (prepared.notAfter <= now) throw new AgentPaymentError("purchase_expired")
      this.db.prepare("INSERT INTO agent_sender_state(lane,next_nonce) VALUES(?,?) ON CONFLICT(lane) DO UPDATE SET next_nonce=excluded.next_nonce").run(lane, nonce+1)
      this.db.prepare("INSERT INTO agent_payment_jobs(payment_key,request_id,intent_hash,lane,nonce,prepared,unsigned_tx,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'reserved',?,?)")
        .run(key, requestId, prepared.intentHash, lane, nonce, JSON.stringify(prepared), JSON.stringify({ ...unsigned, nonce }), now, now)
      this.db.exec("COMMIT"); return this.get(key)!
    } catch (error) { this.db.exec("ROLLBACK"); throw error }
  }
  storeRaw(key: string, raw: Hex, hash: Hex): Job {
    this.db.exec("BEGIN IMMEDIATE")
    try {
      const job = this.get(key)
      if (!job) throw new Error("Unknown job")
      if (job.raw_tx && (job.raw_tx !== raw || job.tx_hash !== hash)) throw new Error("Signed transaction is immutable")
      this.db.prepare("UPDATE agent_payment_jobs SET raw_tx=?,tx_hash=?,state='prepared',updated_at=? WHERE payment_key=? AND raw_tx IS NULL")
        .run(raw, hash, Date.now(), key)
      this.db.exec("COMMIT"); return this.get(key)!
    } catch (error) { this.db.exec("ROLLBACK"); throw error }
  }
  update(key: string, state: JobState, receipt: Record<string, unknown> | null = null, error: string | null = null, finalized = false) {
    this.db.prepare("UPDATE agent_payment_jobs SET state=?,receipt=?,last_error=?,finalized=?,updated_at=? WHERE payment_key=? AND finalized=0")
      .run(state, receipt ? JSON.stringify(receipt) : null, error, finalized ? 1 : 0, Date.now(), key)
  }
  incomplete(): Job[] { return this.db.prepare("SELECT * FROM agent_payment_jobs WHERE finalized=0 AND state NOT IN ('expired_unpaid') ORDER BY nonce LIMIT 100").all() as Job[] }
  close() { this.db.close() }
}
