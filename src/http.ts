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
  const mcpApiKey = process.env.MCP_API_KEY?.trim() ?? "";

  if (!apiId || !apiToken) {
    throw new Error(
      "Missing Aircall credentials. Set AIRCALL_API_ID and AIRCALL_API_TOKEN.",
    );
  }

  if (!mcpApiKey) {
    throw new Error(
      "Missing MCP API key. Set MCP_API_KEY to secure the server.",
    );
  }

  if (mcpApiKey.length < 32) {
    throw new Error(
      "MCP_API_KEY must be at least 32 characters for security.",
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

  // Authenticate requests using X-API-Key header.
  // Returns true if authenticated, false if rejected (response already sent).
  function authenticate(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    const providedKey = req.headers["x-api-key"] as string | undefined;

    if (!providedKey || providedKey !== mcpApiKey) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized. Provide a valid X-API-Key header." }));
      return false;
    }

    return true;
  }

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);

    // CORS headers for cross-origin MCP clients.
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, Mcp-Session-Id, Accept, mcp-session-id, X-API-Key, x-api-key",
    );
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id, mcp-session-id");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Health check (unauthenticated, needed for Fly health checks).
    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    // =============================================
    // Streamable HTTP transport at /mcp
    // =============================================
    if (url.pathname === "/mcp") {
      if (!authenticate(req, res)) return;

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
      if (!authenticate(req, res)) return;

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
      if (!authenticate(req, res)) return;

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

    // Root: basic info (unauthenticated).
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          name: "aircall-mcp",
          description: "Read-only MCP server for Aircall (authentication required)",
          endpoints: {
            mcp: "/mcp (Streamable HTTP, requires X-API-Key header)",
            sse: "/sse (legacy SSE, requires X-API-Key header)",
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
    console.error(`aircall-mcp: All MCP endpoints require X-API-Key header`);
  });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`aircall-mcp: ${message}`);
  process.exit(1);
});
