#!/usr/bin/env node
/**
 * stdio launcher for `jpyc-x402-mcp`.
 *
 * Usage from a Claude Desktop / Cursor MCP config:
 *
 *   {
 *     "mcpServers": {
 *       "jpyc-x402": {
 *         "command": "npx",
 *         "args": ["-y", "@jpyc-x402/mcp"],
 *         "env": { "BUYER_PRIVATE_KEY": "0x..." }
 *       }
 *     }
 *   }
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { buildMcpServer } from "./server.js"

async function main() {
  const server = buildMcpServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((err) => {
  console.error("[jpyc-x402-mcp] fatal:", err)
  process.exit(1)
})
