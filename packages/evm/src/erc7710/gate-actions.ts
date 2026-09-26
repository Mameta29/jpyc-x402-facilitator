import { gateAbi, gateDomain, digest, structHash, grantsHash, parseGateAction, type GateAction } from '@jpyc-ec/agent-commerce'
import { decodeEventLog, encodeFunctionData, type Address, type Hex, type TransactionReceipt } from 'viem'
import { AgentPaymentError, type AgentPurchaseEngine } from './engine.js'

export interface PreparedGateAction {
  kind: 'gate_action'; action: GateAction['kind']; jobKey: string; intentHash: Hex;
  chainId: number; to: Address; data: Hex; value: '0x0'; notAfter: number;
  expected: { account: Address; policyId?: Hex; version?: string; orderId?: Hex }
}
export class GateActionEngine {
  constructor(private readonly purchase: AgentPurchaseEngine) {}
  async prepare(input: unknown): Promise<PreparedGateAction> {
    const action = parseGateAction(input), { manifest: m, client, relayer } = this.purchase
    const domain = gateDomain(m.chainId, m.gate), now = Math.floor(Date.now() / 1000)
    if (action.validUntil <= BigInt(now) || action.validUntil > BigInt(now + 300)) throw new AgentPaymentError('gate_action_deadline')
    await this.purchase.verifyDeployment()
    const account = 'policy' in action ? action.policy.account : action.account
    const code = await client.getCode({ address: account })
    if (code?.toLowerCase() !== `0xef0100${m.accountImplementation.slice(2)}`.toLowerCase()) throw new AgentPaymentError('account_implementation_mismatch')
    let data: Hex, actionHash: Hex, expected: PreparedGateAction['expected']
    if ('policy' in action) {
      const args = [action.policy, action.merchants, action.assets, action.grants, action.relayers, action.nonce, action.validUntil, action.signature] as const
      const functionName = action.kind === 'register' ? 'registerPolicy' : 'updatePolicy'
      data = encodeFunctionData({ abi: gateAbi, functionName, args })
      actionHash = digest(domain, 'PolicyRegistration', { policyHash: structHash('Policy', action.policy), grantsHash: grantsHash(action.grants), nonce: action.nonce, validUntil: action.validUntil })
      expected = { account, policyId: action.policy.policyId, version: action.policy.version.toString() }
    } else if (action.kind === 'revoke') {
      data = encodeFunctionData({ abi: gateAbi, functionName: 'revokePolicy', args: [account, action.policyId, action.nonce, action.validUntil, action.signature] })
      actionHash = digest(domain, 'Revoke', { account, policyId: action.policyId, nonce: action.nonce, validUntil: action.validUntil })
      expected = { account, policyId: action.policyId }
    } else {
      data = encodeFunctionData({ abi: gateAbi, functionName: 'cancelOrder', args: [account, action.orderId, action.nonce, action.validUntil, action.signature] })
      actionHash = digest(domain, 'Cancel', { account, orderId: action.orderId, nonce: action.nonce, validUntil: action.validUntil })
      expected = { account, orderId: action.orderId }
    }
    try { await client.call({ account: relayer, to: m.gate, data, value: 0n }) }
    catch { throw new AgentPaymentError('gate_action_simulation_failed', 409) }
    return { kind: 'gate_action', action: action.kind, jobKey: `gate_action:eip155:${m.chainId}:${m.gate.toLowerCase()}:${account.toLowerCase()}:${action.nonce}`, intentHash: actionHash,
      chainId: m.chainId, to: m.gate, data, value: '0x0', notAfter: Number(action.validUntil), expected }
  }
  verifyReceipt(receipt: TransactionReceipt, p: PreparedGateAction): boolean {
    const same = (a: string | null | undefined, b: string | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase()
    if (receipt.status !== 'success' || !same(receipt.to, this.purchase.manifest.gate) || !same(receipt.from, this.purchase.relayer)) return false
    let count = 0
    for (const log of receipt.logs) {
      if (!same(log.address, p.to)) continue
      try {
        const e = decodeEventLog({ abi: gateAbi, data: log.data, topics: log.topics, strict: true })
        if ((p.action === 'register' || p.action === 'update') && e.eventName === 'PolicyRegistered' && same(e.args.account, p.expected.account) && same(e.args.policyId, p.expected.policyId) && e.args.version.toString() === p.expected.version) count++
        if (p.action === 'revoke' && e.eventName === 'PolicyRevoked' && same(e.args.account, p.expected.account) && same(e.args.policyId, p.expected.policyId)) count++
        if (p.action === 'cancel' && e.eventName === 'OrderCancellation' && same(e.args.account, p.expected.account) && same(e.args.orderId, p.expected.orderId)) count++
      } catch { /* Ignore unrelated events, never infer success from receipt status alone. */ }
    }
    return count === 1
  }
}
