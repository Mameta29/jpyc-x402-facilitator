import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'

// No real RPC, relayer or backend credentials are read by this bundle acceptance.
const rpc = createServer(async (req, res) => {
  let body = ''
  for await (const part of req) body += part
  const q = JSON.parse(body)
  const answer = r => ({ jsonrpc: '2.0', id: r.id, result: r.method === 'eth_chainId' ? '0x89' : '0x0' })
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(Array.isArray(q) ? q.map(answer) : answer(q)))
})
await new Promise(resolve => rpc.listen(0, '127.0.0.1', resolve))
const child = spawn(process.execPath, ['dist/agent-staging/facilitator.mjs'], {
  env: { PATH: process.env.PATH, NODE_ENV: 'development', HOST: '127.0.0.1', PORT: '18492',
    ENABLED_NETWORKS: 'eip155:137', RPC_URLS_137: `http://127.0.0.1:${rpc.address().port}`,
    RELAYER_PRIVATE_KEY: '0x' + '1'.repeat(64) },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let log = ''
child.stdout.on('data', data => { log += data })
child.stderr.on('data', data => { log += data })
const exited = new Promise(resolve => child.once('exit', resolve))
try {
  let healthy = false
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) break
    try {
      const response = await fetch('http://127.0.0.1:18492/health')
      if (response.ok) { assert.deepEqual(await response.json(), { ok: true }); healthy = true; break }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.ok(healthy, log)
  assert.ok(log.includes('127.0.0.1:18492'))
  console.log('Portable facilitator health and loopback binding passed')
} finally {
  child.kill('SIGTERM')
  await exited
  await new Promise(resolve => rpc.close(resolve))
}
