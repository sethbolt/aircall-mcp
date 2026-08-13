#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { AircallClient } from "./client.js";
import { createAircallServer } from "./server.js";

function positiveIntegerEnvironment(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

async function main(): Promise<void> {
  const apiId = process.env.AIRCALL_API_ID?.trim() ?? "";
  const apiToken = process.env.AIRCALL_API_TOKEN?.trim() ?? "";

  if (!apiId || !apiToken) {
    throw new Error(
      "Missing Aircall credentials. Set AIRCALL_API_ID and AIRCALL_API_TOKEN in the MCP server environment.",
    );
  }

  const api = new AircallClient({
    apiId,
    apiToken,
    timeoutMs: positiveIntegerEnvironment("AIRCALL_TIMEOUT_MS", 30_000),
  });
  const server = createAircallServer(api);
  const transport = new StdioServerTransport();

  await server.connect(transport);
  console.error("aircall-mcp: read-only stdio server ready");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`aircall-mcp: ${message}`);
  process.exit(1);
});
