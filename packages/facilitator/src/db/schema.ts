/**
 * Drizzle schema for the facilitator's Postgres state.
 *
 * Three tables:
 *
 *  - `settlements`           — every verify/settle attempt, audited.
 *                              Unique on (chain_id, payer, nonce) so we cannot
 *                              double-broadcast the same authorization.
 *
 *  - `rate_limit_buckets`    — per-payer rolling-window counters; cheap upsert
 *                              with a primary key on (payer, window_start).
 *
 *  - `relayer_wallet_health` — last-known native balance per (chain_id,
 *                              relayer address). Updated by the balance
 *                              monitor cron and read on settle.
 */

import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core"

export const settlementStatuses = ["verified", "settling", "settled", "failed"] as const
export type SettlementStatus = (typeof settlementStatuses)[number]

export const settlements = pgTable(
  "settlements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    chainId: integer("chain_id").notNull(),
    asset: varchar("asset", { length: 42 }).notNull(),
    payer: varchar("payer", { length: 42 }).notNull(),
    payTo: varchar("pay_to", { length: 42 }).notNull(),
    valueAtomic: numeric("value_atomic", { precision: 78, scale: 0 }).notNull(),
    nonce: varchar("nonce", { length: 66 }).notNull(),
    validAfter: bigint("valid_after", { mode: "bigint" }).notNull(),
    validBefore: bigint("valid_before", { mode: "bigint" }).notNull(),
    signature: text("signature").notNull(),
    status: text("status").notNull().$type<SettlementStatus>(),
    txHash: varchar("tx_hash", { length: 66 }),
    blockNumber: bigint("block_number", { mode: "bigint" }),
    gasUsed: numeric("gas_used", { precision: 78, scale: 0 }),
    effectiveGasPrice: numeric("effective_gas_price", { precision: 78, scale: 0 }),
    gasCostNative: numeric("gas_cost_native", { precision: 78, scale: 18 }),
    errorReason: text("error_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    settledAt: timestamp("settled_at", { withTimezone: true }),
  },
  (t) => ({
    uqNonce: uniqueIndex("settlements_chain_payer_nonce_uq").on(t.chainId, t.payer, t.nonce),
    idxStatus: index("settlements_status_idx").on(t.status),
    idxCreatedAt: index("settlements_created_at_idx").on(t.createdAt),
  }),
)

export const rateLimitBuckets = pgTable(
  "rate_limit_buckets",
  {
    payer: varchar("payer", { length: 42 }).notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    requestCount: integer("request_count").notNull().default(0),
    totalValueAtomic: numeric("total_value_atomic", { precision: 78, scale: 0 })
      .notNull()
      .default("0"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.payer, t.windowStart] }),
  }),
)

export const relayerWalletHealth = pgTable("relayer_wallet_health", {
  chainId: integer("chain_id").primaryKey(),
  address: varchar("address", { length: 42 }).notNull(),
  lastBalanceNative: doublePrecision("last_balance_native"),
  lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
  isCritical: boolean("is_critical").notNull().default(false),
})
