# aircall-mcp

A local, read-only [Model Context Protocol](https://modelcontextprotocol.io) server for the official [Aircall REST API](https://developers.aircall.io/api-references).

> [!IMPORTANT]
> This is an independent open-source project. It is not built, maintained, or endorsed by Aircall.

## Why this server

Aircall provides an official REST API but does not provide a client-facing MCP server for reading calls and transcripts. `aircall-mcp` provides that MCP layer while keeping credentials and Aircall data on the local machine:

- **Read-only by construction:** only documented `GET` endpoints are implemented.
- **Local stdio transport:** no web server, hosted proxy, account, or subscription.
- **Fixed API origin:** credentials are sent only to `https://api.aircall.io`.
- **No persistence:** responses, transcripts, and contacts are not written to disk.
- **Bounded output:** pagination, compact call results, and transcript slicing limit context usage.
- **Sensitive media URLs omitted by default:** recording, voicemail, asset, and number-message URLs require explicit opt-in.

## Tools

All 21 tools are annotated as read-only, non-destructive, and idempotent.

| Tool | Aircall endpoint |
|---|---|
| `aircall_ping` | `GET /v1/ping` |
| `aircall_get_company` | `GET /v1/company` |
| `aircall_list_users` | `GET /v2/users` |
| `aircall_get_user` | `GET /v2/users/{id-or-email}` |
| `aircall_list_calls` | `GET /v1/calls` |
| `aircall_get_call` | `GET /v1/calls/{id}` |
| `aircall_search_calls` | `GET /v1/calls/search` |
| `aircall_get_transcription` | `GET /v1/calls/{id}/transcription` |
| `aircall_get_sentiments` | `GET /v1/calls/{id}/sentiments` |
| `aircall_get_topics` | `GET /v1/calls/{id}/topics` |
| `aircall_get_summary` | `GET /v1/calls/{id}/summary` |
| `aircall_get_action_items` | `GET /v1/calls/{id}/action_items` |
| `aircall_list_numbers` | `GET /v1/numbers` |
| `aircall_get_number` | `GET /v1/numbers/{id}` |
| `aircall_list_contacts` | `GET /v1/contacts` |
| `aircall_get_contact` | `GET /v1/contacts/{id}` |
| `aircall_search_contacts` | `GET /v1/contacts/search` |
| `aircall_list_teams` | `GET /v1/teams` |
| `aircall_get_team` | `GET /v1/teams/{id}` |
| `aircall_list_tags` | `GET /v1/tags` |
| `aircall_get_tag` | `GET /v1/tags/{id}` |

Conversation Intelligence tools require the applicable Aircall AI feature and data to be available for that call.

## Install

Requirements: Node.js 20 or newer and an Aircall API key pair.

```bash
git clone https://github.com/growth-box/aircall-mcp.git
cd aircall-mcp
npm install
npm run build
```

Create API credentials in **Aircall Dashboard → Integrations → API keys**. Aircall shows the API token only once.

## Configure an MCP client

The server reads credentials from its process environment:

```json
{
  "mcpServers": {
    "aircall": {
      "command": "node",
      "args": ["/absolute/path/to/aircall-mcp/dist/index.js"],
      "env": {
        "AIRCALL_API_ID": "your-api-id",
        "AIRCALL_API_TOKEN": "your-api-token"
      }
    }
  }
}
```

Do not commit or share a configuration containing real credentials.

### Pi with macOS Keychain

Pi's MCP adapter can resolve environment values from commands when the value starts with `!`. This keeps secrets out of JSON configuration.

Store the credentials interactively:

```bash
./scripts/macos-keychain-setup.sh
```

Then add this server to `~/.config/mcp/mcp.json`:

```json
{
  "mcpServers": {
    "aircall": {
      "command": "node",
      "args": ["/absolute/path/to/aircall-mcp/dist/index.js"],
      "env": {
        "AIRCALL_API_ID": "!security find-generic-password -s aircall-mcp -a AIRCALL_API_ID -w",
        "AIRCALL_API_TOKEN": "!security find-generic-password -s aircall-mcp -a AIRCALL_API_TOKEN -w"
      },
      "lifecycle": "lazy"
    }
  }
}
```

Reload Pi, then connect or call `aircall_ping`.

## Aircall API constraints

At the time of implementation, Aircall documents:

- 120 API requests per minute per company.
- A maximum page size of 50.
- A maximum of 10,000 paginated calls or contacts; use date windows to go beyond that.
- Six months of call history through the Public API.

The client retries one `429` response using Aircall's retry/reset headers. It otherwise leaves request scheduling to the MCP client.

## Data handling

Call records, contacts, phone numbers, and transcripts may contain personal or confidential information. This server does not store them, but its results are sent to the connected MCP client and ultimately to that client's language-model provider. Review that provider's privacy and retention controls.

Media URLs are omitted by default because they can grant access to recordings or voicemail. Pass the relevant explicit `include_*_urls` option only when needed. On call-list and call-search tools, opting into media URLs returns full call records even when `compact` is left at its default.

Set `AIRCALL_TIMEOUT_MS` to a positive integer to override the default 30-second request timeout.

See [SECURITY.md](SECURITY.md) for the full security model.

## Development

```bash
npm test
npm run typecheck
```

Tests use mocked Aircall responses and never require live credentials.

## License

MIT
