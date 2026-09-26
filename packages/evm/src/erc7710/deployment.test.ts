import { describe, expect, it } from 'vitest'
import { toHex, type PublicClient } from 'viem'
import { AgentPurchaseEngine, type AgentManifest } from './engine.js'
const a = (n: number) => toHex(n, { size: 20 }), h = (n: number) => toHex(n, { size: 32 })
const manifest: AgentManifest = { chainId: 80002, relayer: a(9), gate: a(1), manager: a(2), jpyc: a(3), usdc: a(4), accountImplementation: a(5), adapter: a(6),
  contracts: [1, 2, 3, 4, 5, 6].map(n => ({ address: a(n), codeHash: h(n) })),
  proxyImplementations: [{ proxy: a(3), implementation: a(7), codeHash: h(7) }, { proxy: a(4), implementation: a(8), codeHash: h(8), slot: h(8) }] }
describe('configured Polygon Amoy execution boundary', () => {
  it('accepts 80002 only with both token implementation pins', () => {
    expect(() => new AgentPurchaseEngine(manifest, {} as PublicClient, a(9), async () => null)).not.toThrow()
    expect(() => new AgentPurchaseEngine({ ...manifest, proxyImplementations: [] }, {} as PublicClient, a(9), async () => null)).toThrow('missing_token_implementation_pin')
  })
  it('rejects an RPC on another chain before reading contracts', async () => {
    const engine = new AgentPurchaseEngine(manifest, { getChainId: async () => 11155111 } as unknown as PublicClient, a(9), async () => null)
    await expect(engine.verifyDeployment()).rejects.toThrow('rpc_chain_mismatch')
  })
  it('does not enable arbitrary chains or missing Gate pins', () => {
    expect(() => new AgentPurchaseEngine({ ...manifest, chainId: 137 }, {} as PublicClient, a(9), async () => null)).toThrow('unsupported_agent_chain')
    expect(() => new AgentPurchaseEngine({ ...manifest, chainId: 1 }, {} as PublicClient, a(9), async () => null)).toThrow('unsupported_agent_chain')
    expect(() => new AgentPurchaseEngine({ ...manifest, contracts: manifest.contracts.slice(1) }, {} as PublicClient, a(9), async () => null)).toThrow('missing_contract_codehash')
  })
  it('rejects a public-chain relayer key that differs from the shared manifest', () => {
    expect(() => new AgentPurchaseEngine(manifest, {} as PublicClient, a(99), async () => null)).toThrow('relayer_manifest_mismatch')
    expect(() => new AgentPurchaseEngine({ ...manifest, relayer: undefined }, {} as PublicClient, a(9), async () => null)).toThrow('relayer_manifest_mismatch')
  })
})
