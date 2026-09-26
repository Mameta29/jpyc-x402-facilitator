import { evidenceDigest, paymentKeyId, LIMITS, type PaymentKey } from "@jpyc-ec/agent-commerce"
import { AgentPaymentError, AgentPurchaseEngine, type PreparedPurchase } from "@jpyc-x402/evm"
import type { AgentCommerceHandler } from "@jpyc-x402/facilitator"
import type { AgentVerifyRequest, SettlementResponse, SupportedKind } from "@jpyc-x402/shared"
import { keccak256, type PrivateKeyAccount, type Hex } from "viem"
import { AgentJournal, type Job, type UnsignedPurchase } from "./agent-journal.js"

export class DurableAgentRunner implements AgentCommerceHandler {
  private readonly running = new Map<string, Promise<void>>()
  constructor(readonly engine: AgentPurchaseEngine, readonly journal: AgentJournal, private readonly account: PrivateKeyAccount) {
    if (engine.relayer.toLowerCase() !== account.address.toLowerCase()) throw new Error("Wrong agent relayer")
  }
  supported(): SupportedKind[] {
    const m = this.engine.manifest
    return [{ x402Version: 2, scheme: "exact", network: `eip155:${m.chainId}`, extra: { assetTransferMethod: "erc7710", jpycPurchaseVersion: 1, gate: m.gate, delegationManager: m.manager, maxHeaderBytes: LIMITS.headerBytes, maxContextBytes: LIMITS.contextBytes, maxChainLength: LIMITS.chainLength } }]
  }
  async verify(request: AgentVerifyRequest) {
    try { const p = await this.engine.prepare(request.paymentPayload, request.paymentRequirements); return { isValid: true, payer: p.expected.payer } }
    catch (error) { return { isValid: false, invalidReason: error instanceof AgentPaymentError ? error.code : "purchase_verification_unavailable" } }
  }
  async settle(request: AgentVerifyRequest): Promise<SettlementResponse> {
    const requestId = evidenceDigest(request)
    try {
      let job = this.journal.findRequest(requestId)
      if (!job) {
        const p = await this.engine.prepare(request.paymentPayload, request.paymentRequirements)
        const existing = this.journal.get(paymentKeyId(p.paymentKey))
        if (existing && (existing.intent_hash !== p.intentHash || existing.request_id !== requestId)) throw new AgentPaymentError("payment_key_conflict", 409)
        const client = this.engine.client
        const [pendingNonce, gas, fees] = await Promise.all([
          client.getTransactionCount({ address: this.account.address, blockTag: "pending" }),
          client.estimateGas({ account: this.account.address, to: p.to, data: p.data, value: 0n }),
          client.estimateFeesPerGas(),
        ])
        if (gas > 3_000_000n || fees.maxFeePerGas > 200_000_000_000n) throw new AgentPaymentError("relayer_cost_limit", 409)
        const unsigned = { chainId: p.chainId, to: p.to, data: p.data, value: "0" as const, gas: (gas*12n/10n+50000n).toString(), maxFeePerGas: fees.maxFeePerGas.toString(), maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString() }
        job = this.journal.reserve(p, requestId, this.account.address, pendingNonce, unsigned)
      }
      await this.recover(job.payment_key)
      return this.response(this.journal.get(job.payment_key)!)
    } catch (error) {
      return { success: false, errorReason: error instanceof AgentPaymentError ? error.code : "purchase_settlement_unavailable", payer: request.paymentPayload.payload.delegator, transaction: "", network: request.paymentRequirements.network }
    }
  }
  private response(job: Job): SettlementResponse {
    const p = JSON.parse(job.prepared) as PreparedPurchase
    return { success: job.state === "confirmed", ...(job.state === "confirmed" ? {} : { errorReason: ["reverted", "expired_unpaid"].includes(job.state) ? job.state : "settlement_pending" }),
      payer: p.expected.payer, transaction: job.tx_hash ?? "", network: p.paymentKey.network, amount: p.expected.amount,
      extensions: { "jpyc.purchase": { state: job.state, intentHash: job.intent_hash, finalized: Boolean(job.finalized), ...(job.receipt ? JSON.parse(job.receipt) as Record<string, unknown> : {}) } },
    }
  }
  async status(key: PaymentKey): Promise<Record<string, unknown>> {
    const id = paymentKeyId(key), job = this.journal.get(id)
    if (!job) return { known: false } // Never evidence of non-payment.
    await this.recover(id)
    const current = this.journal.get(id)!
    return { known: true, ...this.response(current), state: current.state, intentHash: current.intent_hash, finalized: Boolean(current.finalized), ...(current.receipt ? JSON.parse(current.receipt) as Record<string, unknown> : {}) }
  }
  async reconcile() { for (const job of this.journal.incomplete()) await this.recover(job.payment_key) }
  async recover(key: string) {
    const pending = this.running.get(key)
    if (pending) return pending
    const work = this.recoverOne(key).finally(() => this.running.delete(key))
    this.running.set(key, work)
    return work
  }
  private async recoverOne(key: string) {
    let job = this.journal.get(key)!
    if (!job || job.finalized || job.state === "expired_unpaid") return
    const p = JSON.parse(job.prepared) as PreparedPurchase, client = this.engine.client
    try {
      if (!job.raw_tx) {
        // Nonce and all transaction fields were committed before signing.
        // Signing after a crash reproduces the same transaction, never new fees.
        const u = JSON.parse(job.unsigned_tx) as UnsignedPurchase
        const raw = await this.account.signTransaction({ type: "eip1559", chainId: u.chainId, nonce: u.nonce, to: u.to, data: u.data, value: 0n, gas: BigInt(u.gas), maxFeePerGas: BigInt(u.maxFeePerGas), maxPriorityFeePerGas: BigInt(u.maxPriorityFeePerGas) })
        job = this.journal.storeRaw(key, raw, keccak256(raw))
      }
      const hash = job.tx_hash!
      let receipt = await client.getTransactionReceipt({ hash }).catch(() => null)
      if (!receipt) {
        const unsigned = JSON.parse(job.unsigned_tx) as UnsignedPurchase
        const finalizedNonce = await client.getTransactionCount({ address: this.account.address, blockTag: "finalized" })
        if (finalizedNonce > unsigned.nonce && await this.engine.unpaidAfterFinality(p)) { this.journal.update(key, "expired_unpaid", null, null, true); return }
        // Even an expired transaction must consume its reserved nonce. Sending
        // the identical bytes lets Gate revert safely and avoids a permanent
        // nonce gap blocking later orders after a crash before broadcast.
        try {
          const sent = await client.sendRawTransaction({ serializedTransaction: job.raw_tx! })
          if (sent !== hash) throw new Error("RPC hash mismatch")
          this.journal.update(key, "broadcast")
        } catch { this.journal.update(key, "unknown", null, "broadcast_outcome_unknown") }
        receipt = await client.getTransactionReceipt({ hash }).catch(() => null)
      }
      if (!receipt) return
      const block = await client.getBlock({ blockNumber: receipt.blockNumber })
      if (block.hash !== receipt.blockHash) { this.journal.update(key, "unknown", null, "receipt_reorg"); return }
      const latest = await client.getBlockNumber()
      const finalized = await client.getBlock({ blockTag: "finalized" })
      const final = finalized.number >= receipt.blockNumber
      const details = { blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash }
      if (receipt.status === "reverted") { this.journal.update(key, "reverted", details, null, final); return }
      if (!this.engine.verifyReceipt(receipt, p)) { this.journal.update(key, "unknown", details, "receipt_mismatch"); return }
      if (latest - receipt.blockNumber + 1n < 2n) { this.journal.update(key, "broadcast", details); return }
      this.journal.update(key, "confirmed", details, null, final)
    } catch {
      // RPC errors never become success, non-payment, or permission to respend.
      this.journal.update(key, "unknown", job.receipt ? JSON.parse(job.receipt) as Record<string, unknown> : null, "reconciliation_unavailable")
    }
  }
}
