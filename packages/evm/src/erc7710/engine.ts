import {
  gateAbi, digest, gateDomain, requirementsHash, structHash, parseEnvelope,
  type Erc7710Payload, type Erc7710Requirements, type PaymentKey,
} from "@jpyc-ec/agent-commerce"
import { decodeEventLog, encodeFunctionData, erc20Abi, keccak256, parseAbi, type Address, type Hex, type PublicClient, type TransactionReceipt } from "viem"

export type AgentManifest = {
  chainId: number; gate: Address; manager: Address; jpyc: Address; usdc: Address; accountImplementation: Address; adapter: Address;
  relayer?: Address;
  contracts: { address: Address; codeHash: Hex }[];
  proxyImplementations?: { proxy: Address; implementation: Address; codeHash: Hex; slot?: Hex }[];
}
export type PreparedPurchase = {
  paymentKey: Extract<PaymentKey, { method: "erc7710" }>; intentHash: Hex;
  chainId: number; to: Address; data: Hex; value: "0x0"; notAfter: number;
  expected: { gate: Address; orderId: Hex; orderHash: Hex; payer: Address; payTo: Address; token: Address; amount: string; inputToken: Address; maxInput: string; riskDigest: Hex; approvalId: Hex };
}
import { AgentPaymentError } from './errors.js'
export { AgentPaymentError } from './errors.js'

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const assert = (condition: boolean, code: string) => { if (!condition) throw new AgentPaymentError(code) }
const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as Hex

export class AgentPurchaseEngine {
  constructor(readonly manifest: AgentManifest, readonly client: PublicClient, readonly relayer: Address, private readonly resolve: (ref: Hex) => Promise<unknown>) {
    assert([80002, 11155111, 31337].includes(manifest.chainId), "unsupported_agent_chain")
    assert(manifest.contracts.length >= 5, "incomplete_deployment_manifest")
    for (const a of [manifest.gate, manifest.manager, manifest.jpyc, manifest.usdc, manifest.accountImplementation, manifest.adapter]) {
      assert(manifest.contracts.some(c => same(c.address, a)), "missing_contract_codehash")
    }
    if (manifest.chainId !== 31337) {
      for (const token of [manifest.jpyc, manifest.usdc]) assert(Boolean(manifest.proxyImplementations?.some(p => same(p.proxy, token))), "missing_token_implementation_pin")
      assert(Boolean(manifest.relayer && same(manifest.relayer, relayer)), "relayer_manifest_mismatch")
    }
  }
  async verifyDeployment() {
    assert(await this.client.getChainId() === this.manifest.chainId, "rpc_chain_mismatch")
    await Promise.all(this.manifest.contracts.map(async expected => {
      const code = await this.client.getCode({ address: expected.address })
      assert(Boolean(code && code !== "0x" && same(keccak256(code), expected.codeHash)), "deployment_code_changed")
    }))
    await Promise.all((this.manifest.proxyImplementations ?? []).map(async p => {
      const slot = await this.client.getStorageAt({ address: p.proxy, slot: p.slot ?? IMPLEMENTATION_SLOT })
      assert(Boolean(slot && same(`0x${slot.slice(-40)}`, p.implementation)), "proxy_implementation_changed")
      const code = await this.client.getCode({ address: p.implementation })
      assert(Boolean(code && same(keccak256(code), p.codeHash)), "proxy_code_changed")
    }))
    const m = this.manifest
    const pinned = (a: Address) => assert(m.contracts.some(c => same(c.address, a)), "missing_dependency_codehash")
    const [manager, jpyc, usdc, implementation, adapter, validator] = await Promise.all([
      this.client.readContract({ address: m.gate, abi: gateAbi, functionName: 'manager' }),
      this.client.readContract({ address: m.gate, abi: gateAbi, functionName: 'settlementToken' }),
      this.client.readContract({ address: m.gate, abi: gateAbi, functionName: 'inputToken' }),
      this.client.readContract({ address: m.gate, abi: gateAbi, functionName: 'accountImplementation' }),
      this.client.readContract({ address: m.gate, abi: gateAbi, functionName: 'fundingAdapter' }),
      this.client.readContract({ address: m.gate, abi: gateAbi, functionName: 'validator' }),
    ])
    assert(same(manager, m.manager) && same(jpyc, m.jpyc) && same(usdc, m.usdc) && same(implementation, m.accountImplementation) && same(adapter, m.adapter), 'gate_manifest_mismatch')
    pinned(validator)
    const dependencies = await Promise.all([
      ...Array.from({ length: 7 }, (_, i) => this.client.readContract({ address: validator, abi: parseAbi(['function enforcers(uint256) view returns (address)']), functionName: 'enforcers', args: [BigInt(i)] })),
      this.client.readContract({ address: m.adapter, abi: parseAbi(['function router() view returns (address)']), functionName: 'router' }),
      this.client.readContract({ address: m.adapter, abi: parseAbi(['function factory() view returns (address)']), functionName: 'factory' }),
    ])
    dependencies.forEach(pinned)
  }
  async prepare(payload: Erc7710Payload, requirements: Erc7710Requirements): Promise<PreparedPurchase> {
    const m = this.manifest, a = payload.accepted, x = payload.extensions["jpyc.purchase"]
    for (const req of [a, requirements]) {
      assert(req.scheme === "exact" && req.network === `eip155:${m.chainId}` && same(req.asset, m.jpyc) && req.extra.assetTransferMethod === "erc7710" && req.extra.jpycPurchaseVersion === 1 && req.extra.facilitatorAddresses.length === 1 && same(req.extra.facilitatorAddresses[0]!, m.gate), "unsupported_purchase_requirements")
    }
    assert(same(a.payTo, requirements.payTo) && a.amount === requirements.amount && a.maxTimeoutSeconds === requirements.maxTimeoutSeconds, "requirements_mismatch")
    assert(same(payload.payload.delegationManager, m.manager), "manager_mismatch")
    const e = parseEnvelope(await this.resolve(x.executionRef)), o = e.order
    const domain = gateDomain(m.chainId, m.gate)
    assert(same(o.account, payload.payload.delegator) && same(o.payTo, a.payTo) && same(o.settlementToken, a.asset) && o.settlementAmount.toString() === a.amount, "order_payment_mismatch")
    assert(same(e.paymentContext, payload.payload.permissionContext), "payment_context_mismatch")
    assert(same(digest(domain, "PurchaseOrder", o), x.orderHash) && same(e.intent.orderHash, x.orderHash) && same(digest(domain, "ExecutionIntent", e.intent), x.intentHash), "execution_hash_mismatch")
    assert(same(requirementsHash(m.chainId, m.gate, o), o.requirementsHash) && same(structHash("Funding", e.funding), o.fundingHash), "commitment_mismatch")
    assert(same(e.risk.intentHash, x.intentHash), "risk_intent_mismatch")
    await this.verifyDeployment()
    const ownerCode = await this.client.getCode({ address: o.account })
    assert(Boolean(ownerCode && same(ownerCode, `0xef0100${m.accountImplementation.slice(2)}`)), "account_implementation_mismatch")
    const deadlines = [o.validUntil, e.intent.validUntil, e.risk.validUntil]
    if (e.funding.maxInput > 0n) deadlines.push(e.funding.quoteDeadline, e.price.validUntil)
    if (e.signatures.human !== "0x") deadlines.push(e.human.validUntil)
    const notAfter = Number(deadlines.reduce((a, b) => a < b ? a : b))
    assert(Number.isSafeInteger(notAfter) && notAfter > Math.floor(Date.now() / 1000), "purchase_expired")
    const args = [o, e.funding, e.intent, e.paymentContext, e.fundingContext, e.risk, e.price, e.human, e.signatures, e.route] as const
    try { await this.client.simulateContract({ account: this.relayer, address: m.gate, abi: gateAbi, functionName: "executePurchase", args }) }
    catch { throw new AgentPaymentError("purchase_simulation_failed", 409) }
    return {
      paymentKey: { method: "erc7710", network: a.network, payer: o.account, gate: m.gate, orderId: o.orderId }, intentHash: x.intentHash,
      chainId: m.chainId, to: m.gate, data: encodeFunctionData({ abi: gateAbi, functionName: "executePurchase", args }), value: "0x0", notAfter,
      expected: { gate: m.gate, orderId: o.orderId, orderHash: x.orderHash, payer: o.account, payTo: o.payTo, token: m.jpyc, amount: a.amount, inputToken: e.funding.token, maxInput: e.funding.maxInput.toString(), riskDigest: e.risk.riskDigest, approvalId: e.human.approvalId },
    }
  }
  verifyReceipt(receipt: TransactionReceipt, prepared: PreparedPurchase): boolean {
    if (receipt.status !== "success" || receipt.to === null || !same(receipt.to, this.manifest.gate) || !same(receipt.from, this.relayer)) return false
    const x = prepared.expected
    let paid = 0, transferred = 0
    for (const log of receipt.logs) {
      if (same(log.address, x.gate)) {
        try {
          const event = decodeEventLog({ abi: gateAbi, topics: log.topics, data: log.data, strict: true })
          if (event.eventName === "PurchasePaid") {
            const a = event.args
            if (same(a.account, x.payer) && same(a.orderId, x.orderId) && same(a.orderHash, x.orderHash) && same(a.payTo, x.payTo) && a.settlementAmount.toString() === x.amount && same(a.inputToken, x.inputToken) && a.actualInput <= BigInt(x.maxInput) && same(a.riskDigest, x.riskDigest) && same(a.approvalId, x.approvalId)) paid++
          }
        } catch { /* unrelated event */ }
      }
      if (same(log.address, x.token)) {
        try {
          const event = decodeEventLog({ abi: erc20Abi, topics: log.topics, data: log.data, strict: true })
          if (event.eventName === "Transfer" && same(event.args.from, x.payer) && same(event.args.to, x.payTo) && event.args.value.toString() === x.amount) transferred++
        } catch { /* unrelated event */ }
      }
    }
    return paid === 1 && transferred === 1
  }
  async unpaidAfterFinality(prepared: PreparedPurchase): Promise<boolean> {
    const block = await this.client.getBlock({ blockTag: "finalized" })
    if (block.timestamp <= BigInt(prepared.notAfter)) return false
    const paid = await this.client.readContract({ address: this.manifest.gate, abi: gateAbi, functionName: "paidOrderHash", args: [prepared.expected.payer, prepared.expected.orderId], blockNumber: block.number })
    return BigInt(paid) === 0n
  }
}
