#!/usr/bin/env bun
// ★ MCP 어댑터 (1차 인터페이스) — design §9-3(A), §13.
// Every registry tool is exposed as an MCP tool. Handlers go through the SAME
// registry.execute path as CLI/HTTP. Low-level Server API is used so our JSON
// Schemas pass straight through as `inputSchema` (no Zod re-declaration).
//
// Transport: stdio (Claude Desktop / local agents). HTTP/SSE transport can be
// mounted onto the M6 HTTP server later for networked agents (AXIS).

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { loadTools, schemas, execute, get } from "../core/tools/registry.js";

export async function buildMcpServer() {
  await loadTools();
  const server = new Server(
    { name: "ryre", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: schemas().map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.input_schema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    if (!get(name)) {
      return { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true };
    }
    try {
      const result = await execute(name, args ?? {});
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `error: ${e.message}` }], isError: true };
    }
  });

  return server;
}

if (import.meta.main) {
  const server = await buildMcpServer();
  await server.connect(new StdioServerTransport());
  // stdio transport keeps the process alive; logs must go to stderr (stdout is the protocol channel).
  process.stderr.write("[mcp] ryre server listening on stdio\n");
}
