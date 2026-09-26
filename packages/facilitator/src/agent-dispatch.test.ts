import { describe, expect, it, vi } from 'vitest'
import { createApp, type AppDeps } from './app.js'
import { HmacAuthenticator, signRequest } from './auth.js'
import { RateLimiter } from './rate-limit.js'
import { NonceCache } from './nonce-cache.js'

const address = `0x${'11'.repeat(20)}` as const, hash = `0x${'22'.repeat(32)}` as const
const key = { keyId: 'test-ec', secret: 'local-tests-only' }
const requirements = { scheme: 'exact', network: 'eip155:11155111', asset: address, amount: '1', payTo: address, maxTimeoutSeconds: 300,
  extra: { assetTransferMethod: 'erc7710', jpycPurchaseVersion: 1, facilitatorAddresses: [address] } }
const payload = { x402Version: 2, accepted: requirements, payload: { delegationManager: address, permissionContext: '0x', delegator: address },
  extensions: { 'jpyc.purchase': { version: 1, orderHash: hash, intentHash: hash, executionRef: hash } } }
const request = { x402Version: 2, paymentRequirements: requirements, paymentPayload: payload }
function setup(enabled = true) {
  const agent = { supported: vi.fn(() => []), verify: vi.fn(async () => ({ isValid: true, payer: address })),
    settle: vi.fn(async () => ({ success: false, errorReason: 'settlement_pending', payer: address, transaction: hash, network: 'eip155:11155111' })),
    status: vi.fn(async () => ({ known: false })), gateAction: vi.fn(async () => ({ state: 'broadcast', actionId: hash, transaction: hash })),
    gateActionStatus: vi.fn(async () => ({ known: false })) }
  const legacy = { supported: vi.fn(() => []), verify: vi.fn(), settle: vi.fn() }
  const deps = { agentCommerce: enabled ? agent : undefined, facilitator: legacy, settleRunner: {}, rateLimiter: new RateLimiter({ windowSeconds: 60, maxRequests: 20 }),
    nonceCache: new NonceCache(), cors: { origins: [] }, nodeEnv: 'test', authenticator: new HmacAuthenticator({ keys: [key] }) } as unknown as AppDeps
  const app = createApp(deps)
  const post = async (path: string, value: unknown, authenticated = true) => {
    const body = JSON.stringify(value)
    return app.request(path, { method: 'POST', headers: { 'content-type': 'application/json',
      ...(authenticated ? { authorization: await signRequest({ key, method: 'POST', path, body: new TextEncoder().encode(body) }) } : {}) }, body })
  }
  return { app, post, agent, legacy }
}
describe('agent HTTP dispatch, authentication and boundaries', () => {
  it('routes 7710 to the durable runner and retains pending semantics', async () => {
    const { post, agent, legacy } = setup()
    expect((await post('/verify', request)).status).toBe(200)
    const settled = await (await post('/settle', request)).json()
    expect(settled.success).toBe(false); expect(settled.transaction).toBe(hash); expect(settled.errorReason).toBe('settlement_pending')
    expect(agent.verify).toHaveBeenCalledTimes(1); expect(legacy.verify).not.toHaveBeenCalled()
  })
  it('does not fall back to EIP-3009 when 7710 is unsupported or malformed', async () => {
    const disabled = setup(false)
    expect((await disabled.post('/verify', request)).status).toBe(400); expect(disabled.legacy.verify).not.toHaveBeenCalled()
    const enabled = setup()
    const malformed = { ...request, paymentPayload: { ...payload, extensions: {} } }
    expect((await enabled.post('/verify', malformed)).status).toBeGreaterThanOrEqual(400)
    expect(enabled.agent.verify).not.toHaveBeenCalled(); expect(enabled.legacy.verify).not.toHaveBeenCalled()
  })
  it('rejects unauthenticated settlement and all lifecycle operations', async () => {
    const { post, agent } = setup()
    for (const path of ['/settle', '/agent/gate-action', '/agent/gate-action-status']) expect((await post(path, request, false)).status).toBe(401)
    expect(agent.settle).not.toHaveBeenCalled(); expect(agent.gateAction).not.toHaveBeenCalled()
  })
  it('rejects oversize input before parsing or executing it', async () => {
    const { post, agent } = setup()
    expect((await post('/settle', { payload: 'x'.repeat(65536) })).status).toBe(413)
    expect(agent.settle).not.toHaveBeenCalled()
  })
  it('only relays fixed owner-signed lifecycle shapes', async () => {
    const { post, agent } = setup()
    const action = { kind: 'revoke', account: address, policyId: hash, nonce: '0', validUntil: '2000000000', signature: `0x${'33'.repeat(65)}` }
    expect((await post('/agent/gate-action', action)).status).toBe(200)
    expect((await post('/agent/gate-action', { ...action, data: '0x1234' })).status).toBe(400)
    expect(agent.gateAction).toHaveBeenCalledTimes(1)
  })
  it('unknown status remains unknown instead of becoming proof of nonpayment', async () => {
    const { post } = setup()
    const result = await (await post('/settle-status', { method: 'erc7710', network: 'eip155:11155111', payer: address, gate: address, orderId: hash })).json()
    expect(result).toEqual({ known: false })
  })
})
