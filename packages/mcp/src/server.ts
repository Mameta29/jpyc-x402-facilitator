/**
 * MCP server wiring. Uses the official @modelcontextprotocol/sdk to register
 * the tools defined in `tools.ts`. Both stdio and SSE transports are
 * supported via the same server instance.
 *
 * The server is intentionally thin — it owns no state of its own. All state
 * (the buyer's wallet, facilitator URL preferences) is managed by the MCP
 * client (e.g. Claude Desktop config) or by env at server start.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"
import { defaultSignerFromEnv, tools, type ToolDeps } from "./tools.js"

export interface BuildServerOptions {
  toolDeps?: ToolDeps
}

export function buildMcpServer(opts: BuildServerOptions = {}) {
  const deps: ToolDeps = opts.toolDeps ?? {
    resolveSigner: () => defaultSignerFromEnv(),
  }

  const server = new Server(
    { name: "jpyc-x402-facilitator-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: Object.values(tools).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: zodToJsonSchema(t.inputSchema),
      })),
    }
  })

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params
    const tool = (tools as Record<string, (typeof tools)[keyof typeof tools]>)[name]
    if (!tool) {
      return {
        isError: true,
        content: [{ type: "text", text: `unknown tool: ${name}` }],
      }
    }
    const parsed = tool.inputSchema.safeParse(args ?? {})
    if (!parsed.success) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `invalid arguments for ${name}: ${parsed.error.message}`,
          },
        ],
      }
    }
    try {
      const result = await tool.handler(parsed.data as never, deps)
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              result,
              (_k, v) => (typeof v === "bigint" ? v.toString() : v),
              2,
            ),
          },
        ],
      }
    } catch (err) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `tool ${name} threw: ${(err as Error).message}`,
          },
        ],
      }
    }
  })

  return server
}

/**
 * Minimal Zod → JSON Schema conversion for MCP tool descriptors. We keep this
 * conservative — the MCP spec only requires that the schema is valid JSON
 * Schema, not that it's a faithful round-trip. Callers that need richer
 * schema generation can swap in `zod-to-json-schema`.
 */
function zodToJsonSchema(_z: unknown): Record<string, unknown> {
  // We expose objects of unknown shape — agents read the description text
  // for guidance. This keeps the dependency footprint small.
  return { type: "object" }
}
