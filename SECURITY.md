# Security

## Security model

`aircall-mcp` is deliberately local and read-only:

- It uses MCP over stdio; it does not open a listening port.
- It sends requests only to `https://api.aircall.io`.
- It implements documented `GET` endpoints only.
- It does not persist Aircall responses, call metadata, transcripts, or contacts.
- It does not log credentials or API response bodies.
- Every exposed MCP tool is marked read-only and idempotent.

Aircall data can contain personal information and confidential conversations. The MCP client and language-model provider receiving tool results remain separate processors of that data; review their retention and privacy settings.

## Credentials

Provide credentials through `AIRCALL_API_ID` and `AIRCALL_API_TOKEN`. Do not put real credentials in source control or a shared MCP configuration file. Prefer an operating-system credential store. See the macOS Keychain setup in the README.

## Reporting a vulnerability

Please use GitHub's private security-advisory flow for this repository rather than opening a public issue containing sensitive details.
