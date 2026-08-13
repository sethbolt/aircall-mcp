import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";

import { AircallApiError } from "./client.js";
import {
  boundedJson,
  compactCallsResponse,
  formatTranscription,
  omitMediaUrls,
  summarizeNumberMessages,
} from "./format.js";
import type { AircallApi, Query } from "./types.js";

export const SERVER_VERSION = "0.1.0";

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const paginationInput = {
  page: z.number().int().min(1).max(500).default(1).describe("Page number"),
  per_page: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(20)
    .describe("Results per page; Aircall allows 1-50"),
};

const timeWindowInput = {
  from: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Minimum creation time as a Unix timestamp"),
  to: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Maximum creation time as a Unix timestamp"),
  order: z.enum(["asc", "desc"]).default("desc").describe("Creation-time order"),
};

const callIdInput = {
  call_id: z.number().int().positive().describe("Unique Aircall call ID"),
};

const resourceId = (description: string) =>
  z.number().int().positive().describe(description);

function jsonResult(value: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: boundedJson(value) }],
  };
}

function textResult(text: string): CallToolResult {
  return {
    content: [{ type: "text", text }],
  };
}

function errorResult(error: unknown): CallToolResult {
  let message = "Unexpected error while reading Aircall.";
  if (error instanceof AircallApiError) {
    message = error.message;
  } else if (error instanceof Error) {
    message = error.message;
  }

  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

async function executeJson(request: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return jsonResult(await request());
  } catch (error) {
    return errorResult(error);
  }
}

async function executeText(request: () => Promise<string>): Promise<CallToolResult> {
  try {
    return textResult(await request());
  } catch (error) {
    return errorResult(error);
  }
}

function paginationQuery(input: { page: number; per_page: number }): Query {
  return { page: input.page, per_page: input.per_page };
}

export function createAircallServer(api: AircallApi): McpServer {
  const server = new McpServer(
    {
      name: "aircall-mcp",
      version: SERVER_VERSION,
      websiteUrl: "https://github.com/growth-box/aircall-mcp",
    },
    {
      instructions:
        "Read-only access to the official Aircall REST API. Call and contact data may contain personal or confidential information. Use pagination and retrieve only what the user needs.",
    },
  );

  server.registerTool(
    "aircall_ping",
    {
      title: "Ping Aircall",
      description: "Verify that Aircall is reachable and the configured API credentials are valid.",
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (extra) => executeJson(() => api.get("/v1/ping", {}, { signal: extra.signal })),
  );

  server.registerTool(
    "aircall_get_company",
    {
      title: "Get Aircall company",
      description: "Get basic information about the authenticated Aircall company.",
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (extra) => executeJson(() => api.get("/v1/company", {}, { signal: extra.signal })),
  );

  server.registerTool(
    "aircall_list_users",
    {
      title: "List Aircall users",
      description: "List Aircall users/agents using the current v2 Users API.",
      inputSchema: {
        ...paginationInput,
        ...timeWindowInput,
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input, extra) =>
      executeJson(() =>
        api.get(
          "/v2/users",
          {
            ...paginationQuery(input),
            from: input.from,
            to: input.to,
            order: input.order,
          },
          { signal: extra.signal },
        ),
      ),
  );

  server.registerTool(
    "aircall_get_user",
    {
      title: "Get Aircall user",
      description: "Get one Aircall user by numeric ID or email address using the v2 Users API.",
      inputSchema: {
        identifier: z
          .union([z.number().int().positive(), z.email().max(254)])
          .describe("Aircall user ID or email address"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ identifier }, extra) =>
      executeJson(() =>
        api.get(
          `/v2/users/${encodeURIComponent(String(identifier))}`,
          {},
          { signal: extra.signal },
        ),
      ),
  );

  server.registerTool(
    "aircall_list_calls",
    {
      title: "List Aircall calls",
      description:
        "List calls from Aircall's available six-month history. Results default to compact newest-first metadata; retrieve a call by ID for complete details.",
      inputSchema: {
        ...paginationInput,
        ...timeWindowInput,
        fetch_contact: z.boolean().default(false).describe("Include matched contact details"),
        fetch_call_timeline: z.boolean().default(false).describe("Include IVR timeline data"),
        fetch_aiva_conv: z.boolean().default(false).describe("Include AI Voice Agent data"),
        compact: z.boolean().default(true).describe("Return compact call metadata"),
        include_media_urls: z
          .boolean()
          .default(false)
          .describe("Include recording, voicemail, and asset URLs"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input, extra) =>
      executeJson(async () => {
        let result = await api.get("/v1/calls", {
          ...paginationQuery(input),
          from: input.from,
          to: input.to,
          order: input.order,
          fetch_contact: input.fetch_contact || undefined,
          fetch_call_timeline: input.fetch_call_timeline || undefined,
          fetch_aiva_conv: input.fetch_aiva_conv || undefined,
        }, { signal: extra.signal });
        if (input.compact) result = compactCallsResponse(result);
        if (!input.include_media_urls) result = omitMediaUrls(result);
        return result;
      }),
  );

  server.registerTool(
    "aircall_get_call",
    {
      title: "Get Aircall call",
      description: "Get full metadata for one Aircall call.",
      inputSchema: {
        ...callIdInput,
        fetch_contact: z.boolean().default(false).describe("Include matched contact details"),
        fetch_call_timeline: z.boolean().default(false).describe("Include IVR timeline data"),
        fetch_aiva_conv: z.boolean().default(false).describe("Include AI Voice Agent data"),
        include_media_urls: z
          .boolean()
          .default(false)
          .describe("Include recording, voicemail, and asset URLs"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input, extra) =>
      executeJson(async () => {
        const result = await api.get(
          `/v1/calls/${input.call_id}`,
          {
            fetch_contact: input.fetch_contact || undefined,
            fetch_call_timeline: input.fetch_call_timeline || undefined,
            fetch_aiva_conv: input.fetch_aiva_conv || undefined,
          },
          { signal: extra.signal },
        );
        return input.include_media_urls ? result : omitMediaUrls(result);
      }),
  );

  server.registerTool(
    "aircall_search_calls",
    {
      title: "Search Aircall calls",
      description:
        "Search calls by date, direction, user, phone number, and tag IDs. Aircall applies multiple tags as an AND condition.",
      inputSchema: {
        ...paginationInput,
        ...timeWindowInput,
        direction: z.enum(["inbound", "outbound"]).optional(),
        user_id: z.number().int().positive().optional(),
        phone_number: z.string().min(3).max(40).optional(),
        tags: z.array(z.number().int().positive()).max(20).optional(),
        fetch_contact: z.boolean().default(false).describe("Include matched contact details"),
        compact: z.boolean().default(true).describe("Return compact call metadata"),
        include_media_urls: z
          .boolean()
          .default(false)
          .describe("Include recording, voicemail, and asset URLs"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input, extra) =>
      executeJson(async () => {
        let result = await api.get(
          "/v1/calls/search",
          {
            ...paginationQuery(input),
            from: input.from,
            to: input.to,
            order: input.order,
            direction: input.direction,
            user_id: input.user_id,
            phone_number: input.phone_number,
            tags: input.tags,
            fetch_contact: input.fetch_contact || undefined,
          },
          { signal: extra.signal },
        );
        if (input.compact) result = compactCallsResponse(result);
        if (!input.include_media_urls) result = omitMediaUrls(result);
        return result;
      }),
  );

  server.registerTool(
    "aircall_get_transcription",
    {
      title: "Get Aircall call transcription",
      description:
        "Get an AI-generated call transcription. Utterances are paginated locally to keep responses bounded.",
      inputSchema: {
        ...callIdInput,
        mode: z.enum(["async", "realtime"]).default("async"),
        offset: z.number().int().nonnegative().default(0),
        limit: z.number().int().min(1).max(500).default(200),
        format: z.enum(["text", "json"]).default("text"),
        include_timestamps: z.boolean().default(true),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input, extra) =>
      executeText(async () => {
        const result = await api.get(
          `/v1/calls/${input.call_id}/transcription`,
          { mode: input.mode === "realtime" ? input.mode : undefined },
          { signal: extra.signal },
        );
        return formatTranscription(result, {
          offset: input.offset,
          limit: input.limit,
          format: input.format,
          includeTimestamps: input.include_timestamps,
        });
      }),
  );

  for (const insight of [
    ["aircall_get_sentiments", "sentiments", "sentiment analysis"],
    ["aircall_get_topics", "topics", "AI-detected topics"],
    ["aircall_get_summary", "summary", "AI-generated summary"],
    ["aircall_get_action_items", "action_items", "AI-extracted action items"],
  ] as const) {
    const [name, endpoint, description] = insight;
    server.registerTool(
      name,
      {
        title: `Get Aircall call ${endpoint.replace("_", " ")}`,
        description: `Get ${description} for one Aircall call. Requires the applicable Aircall AI feature.`,
        inputSchema: callIdInput,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      async ({ call_id }, extra) =>
        executeJson(() =>
          api.get(`/v1/calls/${call_id}/${endpoint}`, {}, { signal: extra.signal }),
        ),
    );
  }

  server.registerTool(
    "aircall_list_numbers",
    {
      title: "List Aircall numbers",
      description: "List phone numbers owned by the Aircall company.",
      inputSchema: {
        ...paginationInput,
        ...timeWindowInput,
        include_message_urls: z
          .boolean()
          .default(false)
          .describe("Include configured audio-message URLs instead of booleans"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input, extra) =>
      executeJson(async () => {
        const result = await api.get(
          "/v1/numbers",
          {
            ...paginationQuery(input),
            from: input.from,
            to: input.to,
            order: input.order,
          },
          { signal: extra.signal },
        );
        return input.include_message_urls ? result : summarizeNumberMessages(result);
      }),
  );

  server.registerTool(
    "aircall_get_number",
    {
      title: "Get Aircall number",
      description: "Get one Aircall phone number and its assigned users.",
      inputSchema: {
        number_id: resourceId("Unique Aircall number ID"),
        include_message_urls: z
          .boolean()
          .default(false)
          .describe("Include configured audio-message URLs instead of booleans"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input, extra) =>
      executeJson(async () => {
        const result = await api.get(
          `/v1/numbers/${input.number_id}`,
          {},
          { signal: extra.signal },
        );
        return input.include_message_urls ? result : summarizeNumberMessages(result);
      }),
  );

  server.registerTool(
    "aircall_list_contacts",
    {
      title: "List Aircall contacts",
      description: "List shared Aircall contacts.",
      inputSchema: {
        ...paginationInput,
        ...timeWindowInput,
        order_by: z.enum(["created_at", "updated_at"]).default("created_at"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input, extra) =>
      executeJson(() =>
        api.get(
          "/v1/contacts",
          {
            ...paginationQuery(input),
            from: input.from,
            to: input.to,
            order: input.order,
            order_by: input.order_by,
          },
          { signal: extra.signal },
        ),
      ),
  );

  server.registerTool(
    "aircall_get_contact",
    {
      title: "Get Aircall contact",
      description: "Get one shared Aircall contact.",
      inputSchema: {
        contact_id: resourceId("Unique Aircall contact ID"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ contact_id }, extra) =>
      executeJson(() =>
        api.get(`/v1/contacts/${contact_id}`, {}, { signal: extra.signal }),
      ),
  );

  server.registerTool(
    "aircall_search_contacts",
    {
      title: "Search Aircall contacts",
      description: "Search shared Aircall contacts by phone number or email address.",
      inputSchema: {
        ...paginationInput,
        ...timeWindowInput,
        order_by: z.enum(["created_at", "updated_at"]).default("created_at"),
        phone_number: z.string().min(3).max(40).optional(),
        email: z.email().max(254).optional(),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input, extra) =>
      executeJson(() =>
        api.get(
          "/v1/contacts/search",
          {
            ...paginationQuery(input),
            from: input.from,
            to: input.to,
            order: input.order,
            order_by: input.order_by,
            phone_number: input.phone_number,
            email: input.email,
          },
          { signal: extra.signal },
        ),
      ),
  );

  server.registerTool(
    "aircall_list_teams",
    {
      title: "List Aircall teams",
      description: "List Aircall teams and their members.",
      inputSchema: {
        ...paginationInput,
        order: timeWindowInput.order,
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input, extra) =>
      executeJson(() =>
        api.get(
          "/v1/teams",
          { ...paginationQuery(input), order: input.order },
          { signal: extra.signal },
        ),
      ),
  );

  server.registerTool(
    "aircall_get_team",
    {
      title: "Get Aircall team",
      description: "Get one Aircall team and its members.",
      inputSchema: {
        team_id: resourceId("Unique Aircall team ID"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ team_id }, extra) =>
      executeJson(() => api.get(`/v1/teams/${team_id}`, {}, { signal: extra.signal })),
  );

  server.registerTool(
    "aircall_list_tags",
    {
      title: "List Aircall tags",
      description: "List call tags configured for the Aircall company.",
      inputSchema: paginationInput,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input, extra) =>
      executeJson(() =>
        api.get("/v1/tags", paginationQuery(input), { signal: extra.signal }),
      ),
  );

  server.registerTool(
    "aircall_get_tag",
    {
      title: "Get Aircall tag",
      description: "Get one Aircall call tag.",
      inputSchema: {
        tag_id: resourceId("Unique Aircall tag ID"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ tag_id }, extra) =>
      executeJson(() => api.get(`/v1/tags/${tag_id}`, {}, { signal: extra.signal })),
  );

  return server;
}
