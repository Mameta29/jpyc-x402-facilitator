import { describe, it, expect } from "vitest"
import { loadConfig } from "@jpyc-x402/facilitator"
import { configEnvironment } from "../src/config-env"
const base = { NODE_ENV: "production", CORS_ORIGINS: "https://ec.jpyc-service.com" }
describe("additional integrator authentication", () => {
  it("retains every existing key while accepting a new integrator", () => {
    const env = {
      ...base,
      FACILITATOR_HMAC_KEYS: "ec-primary:old-secret,ec-backup:backup-secret",
      FACILITATOR_EXTRA_HMAC_KEYS: "pay-prod:new-secret",
    }
    const config = loadConfig(configEnvironment(env))
    expect(config.hmacKeys.map((k) => k.keyId)).toEqual(["ec-primary", "ec-backup", "pay-prod"])
    expect(env.FACILITATOR_HMAC_KEYS).toBe("ec-primary:old-secret,ec-backup:backup-secret")
  })
  it("preserves legacy configuration when the optional binding is absent", () => {
    expect(
      loadConfig(configEnvironment({ ...base, FACILITATOR_HMAC_KEYS: "ec:old-secret" })).hmacKeys,
    ).toHaveLength(1)
  })
  it("remains closed without credentials and rejects duplicate key IDs", () => {
    expect(() => loadConfig(configEnvironment(base))).toThrow()
    expect(() =>
      loadConfig(
        configEnvironment({
          ...base,
          FACILITATOR_HMAC_KEYS: "ec:old-secret",
          FACILITATOR_EXTRA_HMAC_KEYS: "ec:new-secret",
        }),
      ),
    ).toThrow()
  })
})
