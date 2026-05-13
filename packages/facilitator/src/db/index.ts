/**
 * Database client wiring. We use `node-postgres` (`pg`) under Drizzle for
 * portability — it works on Render, Fly.io, Neon's pooled endpoint, and any
 * Postgres 13+. Each Hono request takes a connection from the pool and
 * returns it; we don't do per-request transactions because the facilitator
 * mostly does single-row writes.
 */

import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres"
import pg from "pg"
import * as schema from "./schema.js"

export type Database = NodePgDatabase<typeof schema>

export function createDatabase(databaseUrl: string): { db: Database; pool: pg.Pool } {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
  })
  const db = drizzle(pool, { schema })
  return { db, pool }
}

export * from "./schema.js"
