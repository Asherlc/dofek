# Remote MCP

Dofek exposes a remote Model Context Protocol endpoint from the existing API server at:

```text
https://<your-dofek-host>/api/mcp
```

The endpoint uses Streamable HTTP and requires a Dofek MCP bearer token on every request.

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

## Connect A Client

For MCP clients that support remote HTTP servers directly, configure the URL and bearer token:

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
axiom query "['dofek-logs'] | where _time > ago(24h) | search 'Slow query' | project _time, body | sort by _time desc | limit 50" -f json --no-spinner
```

## Auth Failures

Missing or invalid tokens return `401` with `WWW-Authenticate: Bearer`. Tokens without the required tool scope return a tool-level insufficient-scope error.
