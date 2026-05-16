/**
 * Builds the static x402 Bazaar discovery catalog from configuration.
 *
 * The facilitator is DB-free, so the discovery catalog (the resources it
 * advertises at GET /discovery/resources) is not populated from observed
 * settlements — it is declared up front via the X402_DISCOVERY_RESOURCES
 * env var, a JSON array of DiscoveryResource objects.
 *
 * A missing var means discovery is disabled (empty catalog). A malformed
 * var is logged and treated as disabled rather than crashing the host —
 * discovery is non-critical next to verify/settle.
 */

import { z } from "zod"
import { discoveryResourceSchema, type DiscoveryResource } from "@jpyc-x402/shared"

const catalogSchema = z.array(discoveryResourceSchema)

/**
 * Parse the discovery catalog from a raw env string. Returns null when the
 * value is absent or invalid (discovery disabled).
 */
export function parseDiscoveryConfig(
  raw: string | undefined,
): { resources: DiscoveryResource[] } | null {
  if (!raw || raw.trim() === "") return null
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    console.warn("[discovery] X402_DISCOVERY_RESOURCES is not valid JSON — discovery disabled")
    return null
  }
  const parsed = catalogSchema.safeParse(json)
  if (!parsed.success) {
    console.warn(
      `[discovery] X402_DISCOVERY_RESOURCES failed schema validation — discovery disabled: ${parsed.error.message}`,
    )
    return null
  }
  return { resources: parsed.data }
}
