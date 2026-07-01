#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

/**
 * Entry point.
 *
 * The server speaks the Model Context Protocol over stdio, which is the
 * transport MCP clients (Claude Desktop, IDE extensions, etc.) use to launch
 * and talk to local servers. All logging must go to stderr so it never
 * corrupts the JSON-RPC stream on stdout.
 */
async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("qa-mcp-server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error starting qa-mcp-server:", err);
  process.exit(1);
});
