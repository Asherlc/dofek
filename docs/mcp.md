# Remote MCP

Dofek exposes a remote Model Context Protocol endpoint from the existing API server at:

```text
https://<your-dofek-host>/api/mcp
```

The endpoint uses Streamable HTTP and supports two authentication paths:

- OAuth 2.1 authorization code with PKCE for Claude remote custom connectors.
- Manually created MCP bearer tokens for clients such as Claude Code and Codex that support custom HTTP headers.

Remote MCP authorization uses OAuth 2.1 discovery, protected-resource metadata ([RFC 9728](https://www.rfc-editor.org/rfc/rfc9728)), exact redirect URI matching, short-lived access tokens, rotating refresh tokens, and per-tool scopes as required by the [MCP authorization specification](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization).

## Connect Claude

Dofek supports [OAuth Dynamic Client Registration (DCR)](https://www.rfc-editor.org/rfc/rfc7591) ([MCP authorization specification](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)), so Claude creates distinct client credentials automatically. Configure the Claude custom connector with only:

```text
MCP URL: https://<your-dofek-host>/api/mcp
```

Leave the OAuth Client ID and OAuth Client Secret fields empty. Claude discovers `/register` ([RFC 7591 §3](https://www.rfc-editor.org/rfc/rfc7591#section-3)), registers itself, and stores the resulting client credentials. Each registration receives a unique client ID and secret; Dofek encrypts the secret at rest with `CREDENTIAL_ENCRYPTION_KEY_BASE64` using the [AWS Encryption SDK](https://docs.aws.amazon.com/encryption-sdk/latest/developer-guide/introduction.html) raw AES-256-GCM keyring ([`@aws-crypto/client-node`](https://github.com/aws/aws-encryption-sdk-javascript); see [README credential encryption](../README.md#credential-encryption-at-rest-provider-credentials)). Registration secrets expire after 30 days via `client_secret_expires_at` ([RFC 7591 §3.2.1](https://www.rfc-editor.org/rfc/rfc7591#section-3.2.1)).

Claude redirects each user to Dofek to sign in and approve the requested scopes. Access tokens expire after one hour. Refresh tokens expire after 30 days and rotate on every use; reusing an older refresh token fails ([OAuth 2.1 refresh token rotation](https://www.rfc-editor.org/rfc/rfc9700#name-refresh-tokens); [RFC 6819 §5.2.2.3](https://www.rfc-editor.org/rfc/rfc6819#section-5.2.2.3)). The `/revoke` endpoint invalidates the complete access-and-refresh token pair ([RFC 7009](https://www.rfc-editor.org/rfc/rfc7009)). Anthropic documents DCR support and re-registration behavior in its [remote connector developer guide](https://support.claude.com/en/articles/11503834-building-custom-connectors-via-remote-mcp-servers).

The registered callback URLs are:

```text
https://claude.ai/api/mcp/auth_callback
https://claude.com/api/mcp/auth_callback
```

Registrations are rejected unless every callback matches this allowlist exactly ([OAuth 2.1 §4.1.3](https://www.rfc-editor.org/rfc/rfc9700#section-4.1.3); [Anthropic remote connector guide](https://support.claude.com/en/articles/11503834-building-custom-connectors-via-remote-mcp-servers)).

OAuth discovery and protocol endpoints ([MCP authorization specification](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization); [RFC 9728](https://www.rfc-editor.org/rfc/rfc9728); [RFC 8414](https://www.rfc-editor.org/rfc/rfc8414); [RFC 7591](https://www.rfc-editor.org/rfc/rfc7591); [RFC 7009](https://www.rfc-editor.org/rfc/rfc7009)):

```text
/.well-known/oauth-protected-resource/api/mcp
/.well-known/oauth-authorization-server
/register
/authorize
/token
/revoke
```

## Create A Token

Tokens are only needed for clients that use manual bearer token authentication (such as Codex). OAuth-based clients (such as Claude Desktop) authenticate automatically.

Open Dofek Settings and use the **MCP** section to create, copy, list, and revoke tokens.

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
