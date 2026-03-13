#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createSteamReviewServer } from "./server.js";

async function main() {
  const server = createSteamReviewServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("steam-review-summary-mcp is running over stdio");
}

main().catch((error) => {
  console.error("Failed to start stdio MCP server:", error);
  process.exit(1);
});
