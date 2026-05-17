/**
 * Staging smoke test for facilitator HMAC request auth.
 *
 * Hits the real staging facilitator over HTTPS and checks that:
 *   - GET /health is public                          -> 200
 *   - GET /supported with a valid EC signature       -> 200
 *   - GET /supported with no Authorization header     -> 401
 *   - GET /supported with a tampered signature        -> 401
 *
 * The request is signed with the EC platform's own signer (imported by path
 * from the sibling jpyc-ec-platform checkout), so this also exercises the
 * cross-repo wire-format contract against the deployed Worker.
 *
 * Run (do NOT paste the secret into chat — pass it as an env var):
 *
 *   FACILITATOR_HMAC_KEY="ec-staging:<SECRET>" \
 *     node --import tsx scripts/verify-staging-auth.ts
 *
 * Optional: FACILITATOR_URL overrides the default staging host.
 */

import { fileURLToPath } from "node:url"

// EC platform's request signer signature — declared locally so this script
// stays decoupled from the EC repo's type surface.
type SignFacilitatorRequest = (args: {
  key: { keyId: string; secret: string }
  method: string
  path: string
  body: Uint8Array
  now?: Date
}) => Promise<string>

async function main(): Promise<void> {
  const BASE_URL = (
    process.env.FACILITATOR_URL ?? "https://facilitator-staging.jpyc-service.com"
  ).replace(/\/$/, "")

  const rawKey = process.env.FACILITATOR_HMAC_KEY?.trim()
  if (!rawKey) {
    console.error(
      'FACILITATOR_HMAC_KEY is required, e.g. FACILITATOR_HMAC_KEY="ec-staging:<SECRET>"',
    )
    process.exit(2)
  }
  const sep = rawKey.indexOf(":")
  if (sep <= 0 || sep === rawKey.length - 1) {
    console.error("FACILITATOR_HMAC_KEY must be in 'keyId:secret' form")
    process.exit(2)
  }
  const KEY = { keyId: rawKey.slice(0, sep), secret: rawKey.slice(sep + 1) }

  // Import the EC platform's request signer by path — same module the
  // storefront ships. Proves the deployed Worker accepts what the EC produces.
  const ecHmacUrl = new URL(
    "../../jpyc-ec-platform/packages/shared/src/x402/hmac-auth.ts",
    import.meta.url,
  )
  const { signFacilitatorRequest } = (await import(
    fileURLToPath(ecHmacUrl)
  )) as { signFacilitatorRequest: SignFacilitatorRequest }

  let failures = 0
  const check = (label: string, got: number, want: number): void => {
    const ok = got === want
    if (!ok) failures++
    console.log(`${ok ? "✓" : "✗"} ${label}: got ${got}, want ${want}`)
  }

  // 1) /health — public
  {
    const res = await fetch(`${BASE_URL}/health`)
    check("GET /health is public", res.status, 200)
  }

  // 2) /supported with a valid EC signature
  {
    const path = "/supported"
    const authorization = await signFacilitatorRequest({
      key: KEY,
      method: "GET",
      path,
      body: new Uint8Array(0),
    })
    const res = await fetch(`${BASE_URL}${path}`, { headers: { authorization } })
    check("GET /supported with valid signature", res.status, 200)
    if (res.status === 200) {
      const body = (await res.json()) as { kinds?: unknown[] }
      console.log(
        `  advertised kinds: ${Array.isArray(body.kinds) ? body.kinds.length : "?"}`,
      )
    } else {
      console.log(`  body: ${(await res.text()).slice(0, 200)}`)
    }
  }

  // 3) /supported with no Authorization header
  {
    const res = await fetch(`${BASE_URL}/supported`)
    check("GET /supported with no auth", res.status, 401)
  }

  // 4) /supported with a tampered signature
  {
    const path = "/supported"
    const header = await signFacilitatorRequest({
      key: KEY,
      method: "GET",
      path,
      body: new Uint8Array(0),
    })
    const tampered = header.replace(/sig=[0-9a-f]+/, "sig=" + "0".repeat(64))
    const res = await fetch(`${BASE_URL}${path}`, {
      headers: { authorization: tampered },
    })
    check("GET /supported with tampered signature", res.status, 401)
  }

  console.log(
    failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`,
  )
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e: unknown) => {
  console.error("verify-staging-auth failed:", e)
  process.exit(1)
})
