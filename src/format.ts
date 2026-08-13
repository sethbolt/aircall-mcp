const DEFAULT_MAX_OUTPUT_BYTES = 48 * 1024;
const REDACTED_MEDIA_URL = "[media URL omitted; set include_media_urls=true to return it]";
const MEDIA_URL_KEYS = new Set([
  "after_hours",
  "asset",
  "callback_later",
  "closed",
  "ivr",
  "recording",
  "recording_short_url",
  "ringing_tone",
  "unanswered_call",
  "voicemail",
  "voicemail_short_url",
  "waiting",
  "welcome",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncateUtf8(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.byteLength <= maxBytes) return text;
  return buffer.subarray(0, maxBytes).toString("utf8").replace(/\uFFFD$/, "");
}

export function boundedJson(value: unknown, maxBytes = DEFAULT_MAX_OUTPUT_BYTES): string {
  const serialized = JSON.stringify(value ?? null, null, 2) ?? "null";
  if (Buffer.byteLength(serialized, "utf8") <= maxBytes) return serialized;

  const warning =
    "The response exceeded the MCP output limit. Request a smaller page, use compact=true, or retrieve one record by ID.";
  let previewBytes = Math.max(maxBytes - 1_000, 0);
  let envelope = "";

  do {
    envelope = JSON.stringify(
      {
        truncated: true,
        warning,
        preview: truncateUtf8(serialized, previewBytes),
      },
      null,
      2,
    );
    const excess = Buffer.byteLength(envelope, "utf8") - maxBytes;
    if (excess <= 0 || previewBytes === 0) break;
    previewBytes = Math.max(previewBytes - excess - 64, 0);
  } while (true);

  return envelope;
}

export function omitMediaUrls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(omitMediaUrls);
  if (!isRecord(value)) return value;

  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (MEDIA_URL_KEYS.has(key) && typeof child === "string" && child) {
      result[key] = REDACTED_MEDIA_URL;
    } else {
      result[key] = omitMediaUrls(child);
    }
  }
  return result;
}

function compactPerson(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return {
    id: value.id,
    name: value.name,
    email: value.email,
  };
}

function compactContact(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return {
    id: value.id,
    first_name: value.first_name,
    last_name: value.last_name,
    company_name: value.company_name,
  };
}

function compactNumber(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return {
    id: value.id,
    name: value.name,
    digits: value.digits,
    country: value.country,
  };
}

export function compactCall(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return {
    id: value.id,
    direction: value.direction,
    status: value.status,
    missed_call_reason: value.missed_call_reason,
    started_at: value.started_at,
    answered_at: value.answered_at,
    ended_at: value.ended_at,
    duration: value.duration,
    raw_digits: value.raw_digits,
    archived: value.archived,
    user: compactPerson(value.user),
    contact: compactContact(value.contact),
    number: compactNumber(value.number),
    tags: value.tags,
    teams: value.teams,
  };
}

export function compactCallsResponse(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.calls)) return value;
  return {
    meta: value.meta,
    calls: value.calls.map(compactCall),
  };
}

export function summarizeNumberMessages(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = { ...value };
  if (isRecord(value.messages)) {
    result.messages = Object.fromEntries(
      Object.entries(value.messages).map(([key, child]) => [key, Boolean(child)]),
    );
  }
  if (Array.isArray(value.numbers)) {
    result.numbers = value.numbers.map(summarizeNumberMessages);
  }
  if (isRecord(value.number)) {
    result.number = summarizeNumberMessages(value.number);
  }
  return result;
}

function speakerLabel(utterance: Record<string, unknown>): string {
  const participantType = String(utterance.participant_type ?? "unknown");
  if (participantType === "internal" || participantType === "user") return "Agent";
  if (participantType === "external" || participantType === "contact") return "Customer";
  if (
    participantType === "ai_voice_agent" ||
    participantType === "voice_virtual_agent" ||
    participantType === "ai_assistant"
  ) {
    return "AI Agent";
  }
  return participantType;
}

function elapsedTimestamp(seconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const remaining = totalSeconds % 60;
  return hours > 0
    ? `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${remaining.toString().padStart(2, "0")}`
    : `${minutes.toString().padStart(2, "0")}:${remaining.toString().padStart(2, "0")}`;
}

function utteranceTimestamp(utterance: Record<string, unknown>): string {
  if (typeof utterance.start_time === "number" && Number.isFinite(utterance.start_time)) {
    return elapsedTimestamp(utterance.start_time);
  }

  if (typeof utterance.timestamp === "number" && Number.isFinite(utterance.timestamp)) {
    const milliseconds = utterance.timestamp >= 1_000_000_000_000
      ? utterance.timestamp
      : utterance.timestamp * 1_000;
    return new Date(milliseconds).toISOString();
  }

  return "timestamp unavailable";
}

export interface TranscriptionPageOptions {
  offset: number;
  limit: number;
  format: "text" | "json";
  includeTimestamps: boolean;
}

export function formatTranscription(value: unknown, options: TranscriptionPageOptions): string {
  const root = isRecord(value) && isRecord(value.transcription) ? value.transcription : value;
  if (!isRecord(root)) return boundedJson(value);

  const content = isRecord(root.content) ? root.content : {};
  const utterances = Array.isArray(content.utterances) ? content.utterances : [];
  const page = utterances.slice(options.offset, options.offset + options.limit);
  const nextOffset = options.offset + page.length < utterances.length
    ? options.offset + page.length
    : null;

  if (options.format === "json") {
    return boundedJson({
      transcription: {
        ...root,
        content: {
          ...content,
          utterances: page,
        },
      },
      pagination: {
        offset: options.offset,
        count: page.length,
        total: utterances.length,
        next_offset: nextOffset,
      },
    });
  }

  const callId = root.call_id ?? "unknown";
  const language = content.language ?? "unknown";
  const first = page.length > 0 ? options.offset + 1 : 0;
  const last = options.offset + page.length;
  const lines = [
    `# Call ${String(callId)} transcription`,
    `Language: ${String(language)}`,
    `Utterances: ${first}-${last} of ${utterances.length}`,
    "",
  ];

  for (const rawUtterance of page) {
    if (!isRecord(rawUtterance)) continue;
    const text = typeof rawUtterance.text === "string" ? rawUtterance.text.trim() : "";
    if (!text) continue;
    const prefix = options.includeTimestamps
      ? `[${utteranceTimestamp(rawUtterance)}] `
      : "";
    lines.push(`${prefix}${speakerLabel(rawUtterance)}: ${text}`);
  }

  if (nextOffset !== null) {
    lines.push("", `More utterances are available. Call again with offset=${nextOffset}.`);
  }

  const result = lines.join("\n");
  if (Buffer.byteLength(result, "utf8") <= DEFAULT_MAX_OUTPUT_BYTES) return result;

  return `${truncateUtf8(result, DEFAULT_MAX_OUTPUT_BYTES - 200)}\n\n[Output truncated. Request fewer utterances with a smaller limit.]`;
}
