/** Add integrator credentials without replacing the existing encrypted key list. */
export function configEnvironment(env: object): Record<string, string | undefined> {
  const config: Record<string, string | undefined> = {}
  for (const [name, value] of Object.entries(env)) {
    if (typeof value === "string") config[name] = value
  }
  config.FACILITATOR_HMAC_KEYS = [config.FACILITATOR_HMAC_KEYS, config.FACILITATOR_EXTRA_HMAC_KEYS]
    .filter(Boolean)
    .join(",")
  return config
}
