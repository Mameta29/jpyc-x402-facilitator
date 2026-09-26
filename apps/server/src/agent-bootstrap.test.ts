import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const mocks = vi.hoisted(() => ({ verify: vi.fn(), journal: vi.fn(), runner: vi.fn() }))
vi.mock("@jpyc-x402/evm/erc7710", () => ({ AgentPurchaseEngine: class { verifyDeployment = mocks.verify } }))
vi.mock("./agent-journal.js", () => ({ AgentJournal: mocks.journal }))
vi.mock("./agent-runner.js", () => ({ DurableAgentRunner: mocks.runner }))
import { createAgentRunner } from "./agent-bootstrap.js"

const directory = mkdtempSync(join(tmpdir(), "agent-bootstrap-"))
const manifest = join(directory, "manifest.json")
const key = `0x${"01".repeat(32)}`
const env = () => ({
  NODE_ENV: "production", AGENT_COMMERCE_ENABLED: "true", AGENT_DEPLOYMENT_MANIFEST: manifest,
  AGENT_RELAYER_PRIVATE_KEY: key, AGENT_RPC_URL: "https://polygon.example.test",
  AGENT_EC_ORIGIN: "https://shop.example.test", AGENT_EC_KEY_ID: "fac-to-ec", AGENT_EC_HMAC_SECRET: "s".repeat(32),
  AGENT_JOURNAL_PATH: join(directory, "journal.sqlite"),
})
beforeEach(() => { vi.clearAllMocks(); writeFileSync(manifest, JSON.stringify({ chainId: 137 })) })
afterAll(() => rmSync(directory, { recursive: true, force: true }))

describe("agent server deployment configuration", () => {
  it("stays off unless explicitly enabled", async () => {
    expect(await createAgentRunner({})).toBeUndefined()
    expect(mocks.verify).not.toHaveBeenCalled()
  })
  it("accepts Polygon with a dedicated key and opens the journal only after verification", async () => {
    await createAgentRunner(env())
    expect(mocks.verify).toHaveBeenCalledOnce()
    expect(mocks.journal).toHaveBeenCalledWith(join(directory, "journal.sqlite"))
    expect(mocks.verify.mock.invocationCallOrder[0]).toBeLessThan(mocks.journal.mock.invocationCallOrder[0]!)
  })
  it.each([11155111, 31337, 43114, 8217])("rejects a production manifest on chain %s", async chainId => {
    writeFileSync(manifest, JSON.stringify({ chainId }))
    await expect(createAgentRunner(env())).rejects.toThrow("Polygon")
    expect(mocks.verify).not.toHaveBeenCalled()
  })
  it.each([
    { AGENT_RPC_URL: "http://polygon.example.test" },
    { AGENT_EC_ORIGIN: "http://shop.example.test" },
    { AGENT_EC_ORIGIN: "https://shop.example.test/path" },
    { AGENT_EC_ORIGIN: "https://user:password@shop.example.test" },
    { AGENT_EC_HMAC_SECRET: "short" },
    { AGENT_EC_KEY_ID: "id, ts=42" },
    { RELAYER_PRIVATE_KEY: key },
    { NODE_ENV: "test", AGENT_EC_ORIGIN: "ftp://localhost" },
    { NODE_ENV: "test", AGENT_RPC_URL: "ftp://localhost" },
  ])("rejects invalid transport or credentials before network access: %j", async overrides => {
    await expect(createAgentRunner({ ...env(), ...overrides })).rejects.toThrow()
    expect(mocks.verify).not.toHaveBeenCalled()
    expect(mocks.journal).not.toHaveBeenCalled()
  })
  it("allows explicit loopback HTTP only for local test runs", async () => {
    writeFileSync(manifest, JSON.stringify({ chainId: 31337 }))
    await createAgentRunner({ ...env(), NODE_ENV: "test", AGENT_RPC_URL: "http://127.0.0.1:18802", AGENT_EC_ORIGIN: "http://localhost:3104" })
    expect(mocks.verify).toHaveBeenCalledOnce()
  })
})
