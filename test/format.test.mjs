import assert from "node:assert/strict";
import test from "node:test";

import {
  boundedJson,
  compactCallsResponse,
  formatTranscription,
  omitMediaUrls,
  summarizeNumberMessages,
} from "../dist/format.js";

test("omitMediaUrls removes signed media links recursively", () => {
  const result = omitMediaUrls({
    call: {
      id: 1,
      recording: "https://recording.example/signed",
      voicemail: null,
      nested: {
        asset: "https://asset.example/signed",
        messages: {
          welcome: "https://audio.example/welcome.mp3",
          waiting: "https://audio.example/waiting.mp3",
        },
      },
    },
  });

  assert.equal(result.call.id, 1);
  assert.match(result.call.recording, /omitted/);
  assert.equal(result.call.voicemail, null);
  assert.match(result.call.nested.asset, /omitted/);
  assert.match(result.call.nested.messages.welcome, /omitted/);
  assert.match(result.call.nested.messages.waiting, /omitted/);
});

test("compactCallsResponse keeps useful metadata and drops bulky fields", () => {
  const result = compactCallsResponse({
    meta: { current_page: 1 },
    calls: [
      {
        id: 10,
        direction: "inbound",
        duration: 90,
        recording: "secret-url",
        comments: [{ content: "large" }],
        user: { id: 2, name: "Agent", email: "agent@example.test", extra: true },
        number: { id: 3, name: "Sales", digits: "+10000000000", messages: {} },
      },
    ],
  });

  assert.equal(result.calls[0].id, 10);
  assert.equal(result.calls[0].user.name, "Agent");
  assert.equal("recording" in result.calls[0], false);
  assert.equal("comments" in result.calls[0], false);
});

test("formatTranscription labels speakers and paginates utterances", () => {
  const source = {
    transcription: {
      call_id: 42,
      content: {
        language: "en",
        utterances: [
          { start_time: 5, participant_type: "external", text: "Hello" },
          { start_time: 65, participant_type: "internal", text: "Hi there" },
          { start_time: 70, participant_type: "ai_voice_agent", text: "Welcome" },
        ],
      },
    },
  };

  const first = formatTranscription(source, {
    offset: 0,
    limit: 2,
    format: "text",
    includeTimestamps: true,
  });
  assert.match(first, /\[00:05\] Customer: Hello/);
  assert.match(first, /\[01:05\] Agent: Hi there/);
  assert.match(first, /offset=2/);

  const second = JSON.parse(
    formatTranscription(source, {
      offset: 2,
      limit: 2,
      format: "json",
      includeTimestamps: true,
    }),
  );
  assert.equal(second.pagination.total, 3);
  assert.equal(second.pagination.next_offset, null);
  assert.equal(second.transcription.content.utterances[0].text, "Welcome");

  const realtime = formatTranscription(
    {
      call_id: 42,
      content: {
        language: "en-US",
        utterances: [
          {
            timestamp: 1_633_024_803_500,
            participant_type: "external",
            text: "Realtime hello",
          },
        ],
      },
    },
    { offset: 0, limit: 10, format: "text", includeTimestamps: true },
  );
  assert.ok(
    realtime.includes(
      `[${new Date(1_633_024_803_500).toISOString()}] Customer: Realtime hello`,
    ),
  );
});

test("summarizeNumberMessages reports configuration without returning URLs", () => {
  const result = summarizeNumberMessages({
    number: {
      id: 3,
      messages: { welcome: "https://example.test/welcome.mp3", voicemail: null },
    },
  });
  assert.deepEqual(result.number.messages, { welcome: true, voicemail: false });
});

test("boundedJson returns a valid truncation envelope within its byte limit", () => {
  const output = boundedJson({ content: "x\n\"".repeat(20_000) }, 2_000);
  const result = JSON.parse(output);
  assert.equal(result.truncated, true);
  assert.match(result.warning, /smaller page/);
  assert.ok(result.preview.length > 0);
  assert.ok(Buffer.byteLength(output, "utf8") <= 2_000);
});
