import assert from "node:assert/strict";
import test from "node:test";

import { AircallApiError, AircallClient } from "../dist/client.js";

const jsonResponse = (value, init = {}) =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });

test("AircallClient sends Basic Auth only to the fixed Aircall origin", async () => {
  const requests = [];
  const client = new AircallClient({
    apiId: "test-id",
    apiToken: "test-token",
    fetchImplementation: async (input, init) => {
      requests.push({ input: new URL(input), init });
      return jsonResponse({ calls: [] });
    },
  });

  await client.get("/v1/calls/search", {
    page: 2,
    per_page: 10,
    direction: "inbound",
    tags: [11, 22],
  });

  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.equal(request.input.origin, "https://api.aircall.io");
  assert.equal(request.input.pathname, "/v1/calls/search");
  assert.equal(request.input.searchParams.get("page"), "2");
  assert.deepEqual(request.input.searchParams.getAll("tags[]"), ["11", "22"]);
  assert.equal(request.init.method, "GET");
  assert.equal(request.init.redirect, "error");
  assert.equal(
    request.init.headers.Authorization,
    `Basic ${Buffer.from("test-id:test-token").toString("base64")}`,
  );
  assert.equal(request.input.href.includes("test-token"), false);
});

test("AircallClient accepts encoded email path segments", async () => {
  let requestedUrl;
  const client = new AircallClient({
    apiId: "id",
    apiToken: "token",
    fetchImplementation: async (input) => {
      requestedUrl = new URL(input);
      return jsonResponse({ user: { id: 1 } });
    },
  });

  await client.get("/v2/users/person%2Bsales%40example.test");
  assert.equal(requestedUrl.pathname, "/v2/users/person%2Bsales%40example.test");
});

test("AircallClient rejects paths outside documented versioned API routes", async () => {
  const client = new AircallClient({
    apiId: "id",
    apiToken: "token",
    fetchImplementation: async () => jsonResponse({}),
  });

  await assert.rejects(() => client.get("https://example.com/steal"), /Unsupported/);
  await assert.rejects(() => client.get("/v1/../admin"), /Unsupported/);
  await assert.rejects(() => client.get("/v1/%2e%2e/admin"), /Unsupported/);
  await assert.rejects(() => client.get("/v1/calls?redirect=https://example.com"), /Unsupported/);
});

test("AircallClient retries one rate-limited request without exposing response internals", async () => {
  let attempts = 0;
  const sleeps = [];
  const client = new AircallClient({
    apiId: "id",
    apiToken: "token",
    fetchImplementation: async () => {
      attempts += 1;
      if (attempts === 1) {
        return new Response('{"error":"rate limited"}', {
          status: 429,
          headers: { "retry-after": "0" },
        });
      }
      return jsonResponse({ ping: "pong" });
    },
    sleepImplementation: async (milliseconds) => {
      sleeps.push(milliseconds);
    },
  });

  assert.deepEqual(await client.get("/v1/ping"), { ping: "pong" });
  assert.equal(attempts, 2);
  assert.deepEqual(sleeps, [0]);
});

test("AircallClient returns bounded API errors", async () => {
  const client = new AircallClient({
    apiId: "id",
    apiToken: "token",
    maxRateLimitRetries: 0,
    fetchImplementation: async () =>
      new Response('{"error":"Unauthorized","troubleshoot":"Check your API key"}', {
        status: 403,
      }),
  });

  await assert.rejects(
    () => client.get("/v1/company"),
    (error) => {
      assert.ok(error instanceof AircallApiError);
      assert.equal(error.status, 403);
      assert.match(error.message, /HTTP 403/);
      assert.equal(error.message.includes("test-token"), false);
      return true;
    },
  );
});
