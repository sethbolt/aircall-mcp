#!/usr/bin/env node

import http from "node:http";
import crypto from "node:crypto";
import { URL } from "node:url";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

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

  // Streamable HTTP sessions keyed by session ID.
  const streamableSessions = new Map<string, { transport: StreamableHTTPServerTransport; server: ReturnType<typeof createAircallServer> }>();

  // Legacy SSE sessions.
  const sseSessions = new Map<string, SSEServerTransport>();

  function collectBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => resolve(body));
      req.on("error", reject);
    });
  }

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);

    // CORS headers for cross-origin MCP clients.
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, Mcp-Session-Id, Accept, mcp-session-id",
    );
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id, mcp-session-id");

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

    // =============================================
    // Streamable HTTP transport at /mcp
    // =============================================
    if (url.pathname === "/mcp") {
      // POST /mcp: JSON-RPC messages (initialize or subsequent)
      if (req.method === "POST") {
        const bodyText = await collectBody(req);
        let body: unknown;
        try {
          body = JSON.parse(bodyText);
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid JSON" }));
          return;
        }

        const sessionId = req.headers["mcp-session-id"] as string | undefined;

        // If this is an initialize request, create a new session.
        if (isInitializeRequest(body)) {
          let capturedSessionId: string | undefined;

          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => {
              capturedSessionId = crypto.randomUUID();
              return capturedSessionId;
            },
          });

          const server = createAircallServer(api);
          await server.connect(transport);
          await transport.handleRequest(req, res, body);

          if (capturedSessionId) {
            streamableSessions.set(capturedSessionId, { transport, server });

            transport.onclose = () => {
              streamableSessions.delete(capturedSessionId!);
              server.close().catch(() => {});
            };
          }
          return;
        }

        // Subsequent request: look up existing session.
        if (sessionId && streamableSessions.has(sessionId)) {
          const session = streamableSessions.get(sessionId)!;
          await session.transport.handleRequest(req, res, body);
          return;
        }

        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid or missing session. Send an initialize request first." }));
        return;
      }

      // GET /mcp: SSE stream for server-to-client notifications (Streamable HTTP)
      if (req.method === "GET") {
        const sessionId = req.headers["mcp-session-id"] as string | undefined;
        if (sessionId && streamableSessions.has(sessionId)) {
          const session = streamableSessions.get(sessionId)!;
          await session.transport.handleRequest(req, res);
          return;
        }
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid or missing session ID" }));
        return;
      }

      // DELETE /mcp: close session
      if (req.method === "DELETE") {
        const sessionId = req.headers["mcp-session-id"] as string | undefined;
        if (sessionId && streamableSessions.has(sessionId)) {
          const session = streamableSessions.get(sessionId)!;
          await session.transport.handleRequest(req, res);
          return;
        }
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid or missing session ID" }));
        return;
      }
    }

    // =============================================
    // Legacy SSE transport at /sse + /message
    // =============================================
    if (req.method === "GET" && url.pathname === "/sse") {
      const transport = new SSEServerTransport("/message", res);
      const sid = transport.sessionId;
      sseSessions.set(sid, transport);

      const server = createAircallServer(api);

      res.on("close", () => {
        sseSessions.delete(sid);
        server.close().catch(() => {});
      });

      await server.connect(transport);
      return;
    }

    if (req.method === "POST" && url.pathname === "/message") {
      const sessionId = url.searchParams.get("sessionId");
      if (!sessionId || !sseSessions.has(sessionId)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid or missing sessionId" }));
        return;
      }

      const transport = sseSessions.get(sessionId)!;
      await transport.handlePostMessage(req, res);
      return;
    }

    // Root: basic info.
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          name: "aircall-mcp",
          description: "Read-only MCP server for Aircall",
          endpoints: {
            mcp: "/mcp (Streamable HTTP, recommended)",
            sse: "/sse (legacy SSE)",
            health: "/health",
          },
        }),
      );
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  httpServer.listen(port, "0.0.0.0", () => {
    console.error(`aircall-mcp: HTTP server listening on 0.0.0.0:${port}`);
    console.error(`aircall-mcp: Streamable HTTP at /mcp | Legacy SSE at /sse`);
  });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`aircall-mcp: ${message}`);
  process.exit(1);
});
