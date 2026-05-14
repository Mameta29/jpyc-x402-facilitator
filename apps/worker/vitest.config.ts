/**
 * Vitest with the Cloudflare workers pool — runs tests inside workerd so
 * Durable Objects, env bindings, and `cloudflare:workers` imports work
 * exactly like in production.
 */

import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config"

export default defineWorkersConfig({
  test: {
    include: ["test/**/*.test.ts"],
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          // Keep tests deterministic — disable the cron trigger.
          compatibilityDate: "2026-05-01",
          compatibilityFlags: ["nodejs_compat"],
        },
      },
    },
  },
})
