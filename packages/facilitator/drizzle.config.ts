import { defineConfig } from "drizzle-kit"

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://jpyc:jpyc@localhost:5432/jpyc_x402_facilitator",
  },
  strict: true,
  verbose: true,
})
