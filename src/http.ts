#!/usr/bin/env node

import http from "node:http";
import { URL } from "node:url";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

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
      "Missing Aircall credentials. Set AIRCALL_API_ID and AIRCALL_API_TOKEN.",
    );
  }

  const port = positiveIntegerEnvironment("PORT", 3000);

  const api = new AircallClient({
    apiId,
    apiToken,
    timeoutMs: positiveIntegerEnvironment("AIRCALL_TIMEOUT_MS", 30_000),
  });

  const transports = new Map<string, SSEServerTransport>();

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);

    // CORS headers for cross-origin MCP clients.
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization",
    );

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Health check.
    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    // SSE endpoint: establishes a long-lived connection.
    if (req.method === "GET" && url.pathname === "/sse") {
      const transport = new SSEServerTransport("/message", res);
      const sessionId = transport.sessionId;
      transports.set(sessionId, transport);

      const server = createAircallServer(api);

      res.on("close", () => {
        transports.delete(sessionId);
        server.close().catch(() => {});
      });

      await server.connect(transport);
      return;
    }

    // Message endpoint: receives JSON-RPC messages from the client.
    if (req.method === "POST" && url.pathname === "/message") {
      const sessionId = url.searchParams.get("sessionId");
      if (!sessionId || !transports.has(sessionId)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid or missing sessionId" }));
        return;
      }

      const transport = transports.get(sessionId)!;
      await transport.handlePostMessage(req, res);
      return;
    }

    // Root: basic info.
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          name: "aircall-mcp",
          description: "Read-only MCP server for Aircall (HTTP/SSE transport)",
          endpoints: {
            sse: "/sse",
            message: "/message",
            health: "/health",
          },
        }),
      );
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  httpServer.listen(port, () => {
    console.error(`aircall-mcp: HTTP/SSE server listening on port ${port}`);
    console.error(`aircall-mcp: Connect MCP clients to http://localhost:${port}/sse`);
  });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`aircall-mcp: ${message}`);
  process.exit(1);
});
