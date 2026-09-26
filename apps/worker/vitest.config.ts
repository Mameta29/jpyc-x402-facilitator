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
          // loadConfig は staging/production で FACILITATOR_HMAC_KEYS を必須に
          // する (HMAC auth コミット以降)。テストは認証なしのスモークなので
          // development として起動する。
          bindings: {
            NODE_ENV: "development",
            // Exercise the durable path on all mocked chains; staging opts
            // in only the two independently funded testnet senders.
            DURABLE_SETTLEMENT_CHAINS: "1,137,43114,8217,11155111,80002,43113,1001",
          },
        },
      },
    },
  },
})
