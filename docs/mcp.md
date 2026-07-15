# Remote MCP

Dofek exposes a remote Model Context Protocol endpoint from the existing API server at:

```text
https://<your-dofek-host>/api/mcp
```

The endpoint uses Streamable HTTP and requires a Dofek bearer token on every request. It supports two token-issuance paths:

- OAuth 2.1 authorization code with PKCE for Claude remote custom connectors.
- Manually created MCP bearer tokens for clients such as Claude Code and Codex that support custom HTTP headers.

Remote MCP authorization uses OAuth 2.1 discovery, protected-resource metadata, exact redirect URI matching, short-lived access tokens, rotating refresh tokens, and per-tool scopes as required by the [MCP authorization specification](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization).

## Connect Claude

Dofek pre-registers Claude instead of exposing unauthenticated Dynamic Client Registration. Configure the Claude custom connector with:

```text
MCP URL: https://<your-dofek-host>/api/mcp
OAuth Client ID: claude
OAuth Client Secret: <MCP_OAUTH_CLIENT_SECRET from Infisical>
```

Claude redirects users to Dofek to sign in and approve the requested scopes. Access tokens expire after one hour. Refresh tokens expire after 30 days and rotate on every use; reusing an older refresh token fails. The revocation endpoint invalidates the complete access-and-refresh token pair.

The registered callback URLs are:

```text
https://claude.ai/api/mcp/auth_callback
https://claude.com/api/mcp/auth_callback
```

Anthropic documents the current `claude.ai` callback and recommends allowing the `claude.com` callback for forward compatibility in its [remote connector developer guide](https://support.claude.com/en/articles/11503834-building-custom-connectors-via-remote-mcp-servers).

OAuth discovery endpoints:

```text
/.well-known/oauth-protected-resource/api/mcp
/.well-known/oauth-authorization-server
/authorize
/token
/revoke
```

## Create A Token

Open Dofek Settings and use the **MCP Tokens** section to create, copy, list, and revoke tokens.

The UI calls the authenticated tRPC `mcp.createToken` procedure from the logged-in Dofek client session.

Input:

```json
{
  "name": "Codex",
  "scopes": ["health:read", "activity:read", "nutrition:write", "providers:read", "sync:write"],
  "expiresAt": null
}
```

The response includes `token` once. Store it in the MCP client. Dofek stores only a hash.

List existing token metadata with `mcp.listTokens`. Revoke a token with `mcp.revokeToken`.

## Scopes

| Scope | Allows |
|-------|--------|
| `health:read` | Read daily health summaries. |
| `activity:read` | Search activity summaries. |
| `nutrition:write` | Log food entries. |
| `providers:read` | List configured providers and connection status. |
| `sync:write` | Enqueue provider sync jobs. |

## Tools

| Tool | Scope | Purpose |
|------|-------|---------|
| `get_daily_health_summary` | `health:read` | Returns server-computed metrics for one date. |
| `search_activities` | `activity:read` | Searches recent activities. |
| `log_food` | `nutrition:write` | Creates a Dofek food entry from text. |
| `list_providers` | `providers:read` | Lists configured providers and status. |
| `start_provider_sync` | `sync:write` | Enqueues a provider sync job. |

## Connect A Header-Capable Client

For MCP clients that support custom remote HTTP headers directly, configure the URL and a manually created bearer token:

```json
{
  "mcpServers": {
    "dofek": {
      "url": "https://<your-dofek-host>/api/mcp",
      "headers": {
        "Authorization": "Bearer dofek_mcp_..."
      }
    }
  }
}
```

For clients that need a local bridge, use `mcp-remote`:

```bash
npx mcp-remote https://<your-dofek-host>/api/mcp --header "Authorization: Bearer dofek_mcp_..."
```

## Manual Verification

Use the official inspector during development:

```bash
npx @modelcontextprotocol/inspector@latest
```

Set the transport to Streamable HTTP, URL to `https://<your-dofek-host>/api/mcp`, and include the bearer token header.

## Local Axiom MCP

The repo `.mcp.json` also exposes an `axiom` MCP server for production log queries. It starts `mcp-server-axiom` through `npx` and derives `AXIOM_TOKEN`, `AXIOM_URL`, and `AXIOM_ORG_ID` from the authenticated local Axiom CLI config:

```bash
axiom auth status --no-spinner
```

If your current MCP client session does not show Axiom tools, restart the session so `.mcp.json` is reloaded. Until then, use the CLI directly:

```bash
axiom query "['dofek-app-logs'] | where _time > ago(24h) | search 'Slow query' | project _time, body | sort by _time desc | limit 50" -f json --no-spinner
```

## Auth Failures

Missing or invalid tokens return `401` with `WWW-Authenticate: Bearer`. Tokens without the required tool scope return a tool-level insufficient-scope error.
