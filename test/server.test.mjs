import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { AircallApiError } from "../dist/client.js";
import { createAircallServer } from "../dist/server.js";

function textOf(result) {
  return result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

async function withMcp(fakeApi, callback) {
  const server = createAircallServer(fakeApi);
  const client = new Client({ name: "aircall-mcp-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    await callback(client);
  } finally {
    await client.close();
    await server.close();
  }
}

test("server exposes 21 explicitly read-only tools", async () => {
  const api = { get: async () => ({}) };
  await withMcp(api, async (client) => {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 21);
    assert.ok(tools.some((tool) => tool.name === "aircall_get_transcription"));
    assert.ok(tools.some((tool) => tool.name === "aircall_search_contacts"));
    for (const tool of tools) {
      assert.equal(tool.annotations?.readOnlyHint, true, tool.name);
      assert.equal(tool.annotations?.destructiveHint, false, tool.name);
      assert.equal(tool.annotations?.idempotentHint, true, tool.name);
    }
  });
});

test("list calls defaults to compact newest-first output with media omitted", async () => {
  const requests = [];
  const api = {
    get: async (path, query) => {
      requests.push({ path, query });
      return {
        meta: { count: 1, current_page: 1 },
        calls: [
          {
            id: 100,
            direction: "inbound",
            status: "done",
            recording: "https://example.test/signed-recording",
            comments: [{ content: "not returned in compact mode" }],
            user: { id: 2, name: "Agent" },
          },
        ],
      };
    },
  };

  await withMcp(api, async (client) => {
    const result = await client.callTool({ name: "aircall_list_calls", arguments: {} });
    const parsed = JSON.parse(textOf(result));
    assert.equal(parsed.calls[0].id, 100);
    assert.equal("recording" in parsed.calls[0], false);
    assert.equal("comments" in parsed.calls[0], false);
    assert.deepEqual(requests[0], {
      path: "/v1/calls",
      query: {
        page: 1,
        per_page: 20,
        from: undefined,
        to: undefined,
        order: "desc",
        fetch_contact: undefined,
        fetch_call_timeline: undefined,
        fetch_aiva_conv: undefined,
      },
    });
  });
});

test("user lookup safely encodes email identifiers", async () => {
  const requests = [];
  const api = {
    get: async (path, query) => {
      requests.push({ path, query });
      return { user: { id: 1 } };
    },
  };

  await withMcp(api, async (client) => {
    const result = await client.callTool({
      name: "aircall_get_user",
      arguments: { identifier: "person+sales@example.test" },
    });
    assert.equal(result.isError, undefined);
    assert.equal(requests[0].path, "/v2/users/person%2Bsales%40example.test");
  });
});

test("transcription tool formats and paginates official Aircall utterances", async () => {
  const api = {
    get: async () => ({
      transcription: {
        call_id: 88,
        content: {
          language: "en",
          utterances: [
            { start_time: 1, participant_type: "external", text: "Question" },
            { start_time: 3, participant_type: "internal", text: "Answer" },
          ],
        },
      },
    }),
  };

  await withMcp(api, async (client) => {
    const result = await client.callTool({
      name: "aircall_get_transcription",
      arguments: { call_id: 88, limit: 1 },
    });
    const text = textOf(result);
    assert.match(text, /Customer: Question/);
    assert.match(text, /offset=1/);
  });
});

test("realtime mode uses Aircall's current transcription endpoint migration path", async () => {
  const requests = [];
  const api = {
    get: async (path, query) => {
      requests.push({ path, query });
      return { call_id: 88, content: { utterances: [] } };
    },
  };

  await withMcp(api, async (client) => {
    await client.callTool({
      name: "aircall_get_transcription",
      arguments: { call_id: 88, mode: "realtime" },
    });
    assert.deepEqual(requests[0], {
      path: "/v1/calls/88/transcription",
      query: { mode: "realtime" },
    });
  });
});

test("API failures are returned as MCP tool errors", async () => {
  const api = {
    get: async () => {
      throw new AircallApiError("Aircall API returned HTTP 403.", 403, "/v1/company");
    },
  };

  await withMcp(api, async (client) => {
    const result = await client.callTool({ name: "aircall_get_company", arguments: {} });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /HTTP 403/);
  });
});
