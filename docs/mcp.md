# Remote MCP

Dofek exposes a remote Model Context Protocol endpoint at:

```text
https://dofek.fit/api/mcp
```

Production deployments must keep `PUBLIC_URL=https://dofek.fit`; OAuth resource and token audiences are exact canonical URLs, so an alternate production origin is invalid.

## Public-origin cutover precondition

Before retiring a previous production origin, an operator must migrate every active app-level provider webhook callback to `https://dofek.fit/api/webhooks/{provider}` and verify it with that provider. Callback registration is provider-owned external state: some providers expose an API while others require their provider portal, so Dofek intentionally does not attempt a generic automatic re-registration. Retire the previous origin only after each active callback has been verified at the canonical endpoint.

The endpoint uses Streamable HTTP and supports two authentication paths:

- OAuth 2.1 authorization code with PKCE for remote MCP clients (Claude, ChatGPT, and any other client that supports OAuth auto-discovery).
- Manually created MCP bearer tokens for clients such as Claude Code and Codex that support custom HTTP headers.

Remote MCP authorization uses OAuth 2.1 discovery, protected-resource metadata ([RFC 9728](https://www.rfc-editor.org/rfc/rfc9728)), exact redirect URI matching, short-lived access tokens, rotating refresh tokens, and per-tool scopes as required by the [MCP authorization specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization).

## Connect With OAuth

Dofek supports [OAuth Client ID Metadata Documents (CIMD)](https://modelcontextprotocol.io/seps/991-enable-url-based-client-registration-using-oauth-c) and [OAuth Dynamic Client Registration (DCR)](https://www.rfc-editor.org/rfc/rfc7591). Configure the client with only:

```text
MCP URL: https://dofek.fit/api/mcp
```

In Claude, select **Use Anthropic’s hosted client metadata**. Claude then uses its HTTPS metadata URL as the OAuth client ID rather than registering a client. Dofek accepts only public HTTPS metadata hosts, rejects redirects and oversized responses, validates the exact client ID and callback URLs, and caches only validated documents. This is the MCP-recommended client-registration mechanism. [MCP authorization specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)

For clients that do not support CIMD, leave the OAuth Client ID and OAuth Client Secret fields empty to use DCR. The client discovers `/register` ([RFC 7591 §3](https://www.rfc-editor.org/rfc/rfc7591#section-3)), registers itself, and stores the resulting client credentials. Each registration receives a unique client ID and secret; Dofek encrypts the secret at rest with `CREDENTIAL_ENCRYPTION_KEY_BASE64` using the [AWS Encryption SDK](https://docs.aws.amazon.com/encryption-sdk/latest/developer-guide/introduction.html) raw AES-256-GCM keyring ([`@aws-crypto/client-node`](https://github.com/aws/aws-encryption-sdk-javascript); see [credential encryption](credential-encryption.md)). Registration secrets expire after 30 days via `client_secret_expires_at` ([RFC 7591 §3.2.1](https://www.rfc-editor.org/rfc/rfc7591#section-3.2.1)).

The client redirects each user to Dofek to sign in and approve the requested scopes. Access tokens expire after one hour. Refresh tokens expire after 30 days and rotate on every use; reusing an older refresh token fails ([OAuth 2.0 Security BCP refresh token rotation](https://www.rfc-editor.org/rfc/rfc9700#name-refresh-tokens); [RFC 6819 §5.2.2.3](https://www.rfc-editor.org/rfc/rfc6819#section-5.2.2.3)). The `/revoke` endpoint invalidates the complete access-and-refresh token pair ([RFC 7009](https://www.rfc-editor.org/rfc/rfc7009)).

Examples that use this path include [Claude remote connectors](https://support.claude.com/en/articles/11503834-building-custom-connectors-via-remote-mcp-servers) and [ChatGPT apps / connectors](https://developers.openai.com/apps-sdk/build/auth).

### Redirect URI policy

Registrations may use any absolute `https://` callback URL. `http://` is allowed only for loopback hosts (`localhost`, `127.0.0.1`, `::1`) so local MCP clients can complete OAuth during development ([OAuth 2.1](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1-13#section-9.7); [RFC 8252 §7.3](https://datatracker.ietf.org/doc/html/rfc8252#section-7.3)). Fragments, embedded credentials, and non-HTTPS remote URLs are rejected. Authorization and token exchange still require exact redirect URI matching against the registered value ([OAuth 2.0 Security BCP §4.1.3](https://www.rfc-editor.org/rfc/rfc9700#section-4.1.3)).

OAuth discovery and protocol endpoints ([MCP authorization specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization); [RFC 9728](https://www.rfc-editor.org/rfc/rfc9728); [RFC 8414](https://www.rfc-editor.org/rfc/rfc8414); [RFC 7591](https://www.rfc-editor.org/rfc/rfc7591); [RFC 7009](https://www.rfc-editor.org/rfc/rfc7009)):

```text
/.well-known/oauth-protected-resource/api/mcp
/.well-known/oauth-authorization-server
/register
/authorize
/token
/revoke
```

## Create A Token

Tokens are only needed for clients that use manual bearer token authentication (such as Codex). OAuth-based clients authenticate automatically.

Open Dofek web Settings, select **Advanced**, and use the **MCP** section to create, copy, list, and revoke tokens.

The UI calls the authenticated tRPC `mcp.createToken` procedure from the logged-in Dofek client session.

Input:

```json
{
  "name": "Codex",
  "scopes": ["health:read", "activity:read", "nutrition:read", "providers:read", "sync:write"],
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
| `nutrition:read` | Read daily nutrition summaries. |
| `providers:read` | List configured providers and connection status. |
| `sync:write` | Enqueue provider sync jobs. |

## Tools

The canonical tool names, schemas, and scope checks are defined in the [MCP tool implementation](../packages/server/src/mcp/tools.ts).

| Tool | Scope | Purpose |
|------|-------|---------|
| `get_daily_health_summary` | `health:read` | Returns server-computed metrics for one date. |
| `get_health_trends` | `health:read` | Returns daily or weekly health metric aggregates and baseline-relative recovery context for a date range. |
| `render_health_explorer` | `health:read` | Returns a server-computed analytics snapshot and renders the Dofek Analytics Explorer in MCP clients that support Apps UI resources. |
| `get_sleep_summary` | `health:read` | Returns nightly sleep duration, efficiency, stages, and timing. |
| `search_activities` | `activity:read` | Searches activities inside exact date boundaries. |
| `get_activity_details` | `activity:read` | Returns one activity with its strength, climbing, and finger-loading details. |
| `get_activity_summary` | `activity:read` | Aggregates activity volume and effort by type or ISO week. |
| `get_finger_loading` | `activity:read` | Returns structured finger-loading protocols and server-derived effective load inside exact date boundaries. |
| `get_nutrition_summary` | `nutrition:read` | Returns daily calorie, macronutrient, fiber, and meal totals. |
| `get_body_metrics` | `health:read` | Returns weight and body-composition measurements. |
| `list_providers` | `providers:read` | Lists configured providers and status. |
| `start_provider_sync` | `sync:write` | Enqueues a provider sync job. |

For Heart Rate Variability (HRV), resting heart rate, respiratory rate, and sleep
efficiency, `get_health_trends` includes `baseline_relative` on the matching
aggregate. The context contains the preceding 30-day mean, standard deviation,
z-score, sample count and coverage, plus the latest 7-day mean compared with the
preceding 28-day mean. The current day is excluded from its own 30-day baseline;
standard deviation and z-score remain `null` until at least two varied baseline
samples exist. See the canonical
[baseline-relative metric contract](../packages/server/src/contracts/baseline-relative-metrics.ts).

## Connect A Header-Capable Client

For MCP clients that support custom remote HTTP headers directly, configure the URL and a manually created bearer token:

```json
{
  "mcpServers": {
    "dofek": {
      "url": "https://dofek.fit/api/mcp",
      "headers": {
        "Authorization": "Bearer dofek_mcp_..."
      }
    }
  }
}
```

For clients that need a local bridge, use `mcp-remote`:

```bash
pnpm dlx mcp-remote https://dofek.fit/api/mcp --header "Authorization: Bearer dofek_mcp_..."
```

## Manual Verification

Use the official inspector during development:

```bash
pnpm dlx @modelcontextprotocol/inspector@latest
```

Set the transport to Streamable HTTP, URL to `https://dofek.fit/api/mcp`, and include the bearer token header.

## Directory Listings

Dofek publishes one remote Streamable HTTP endpoint. The [MCP Registry remote-server format](https://modelcontextprotocol.io/registry/remote-servers) requires that endpoint to be publicly accessible and records it in the `remotes` field; the checked-in [registry entry](../registry/dofek/server.json) is ready for publishing after the production endpoint is deployed. ChatGPT plugin review also requires a verified individual or business identity, a production MCP URL, a support URL, policy URLs, accurate tool annotations, and reviewer-ready test credentials ([OpenAI submission requirements](https://developers.openai.com/plugins/deploy/submission)).

For other clients, use the OAuth setup above when the client supports remote MCP OAuth discovery, or the bearer-header configuration when it does not. Clients that support MCP Apps UI render `render_health_explorer`; other clients receive the same readable JSON snapshot.

## Local Axiom MCP

The repo `.mcp.json` also exposes an `axiom` MCP server for production log queries. It starts `mcp-server-axiom` through `npx` and derives `AXIOM_TOKEN`, `AXIOM_URL`, and `AXIOM_ORG_ID` from the authenticated local Axiom CLI config. The deployed collector routes application and infrastructure logs to `dofek-logs` ([source](../deploy/otel-collector-config.yaml)).

```bash
axiom auth status --no-spinner
```

If your current MCP client session does not show Axiom tools, restart the session so `.mcp.json` is reloaded. Until then, use the CLI directly:

```bash
axiom query "['dofek-logs'] | where _time > ago(24h) | search 'Slow query' | project _time, body | sort by _time desc | limit 50" -f json --no-spinner
```

## Local XcodeBuildMCP

The repository configures XcodeBuildMCP in both `.mcp.json` and
`.codex/config.toml` so supported agents can build, install, launch, inspect, and
capture logs from the iOS app:

```json
{
  "mcpServers": {
    "xcodebuildmcp": {
      "command": "pnpm",
      "args": ["dlx", "xcodebuildmcp@2.6.2", "mcp"]
    }
  }
}
```

Restart the agent session after cloning or changing the MCP configuration so
the tool catalog reloads. If the current session cannot expose dynamically added
MCP tools, the same package provides a CLI fallback:

```bash
pnpm dlx xcodebuildmcp@2.6.2 simulator list
```

Follow the upstream getting-started guide for prerequisites and tool names:
<https://www.xcodebuildmcp.com/#get-started>. Version 2.6.2 is pinned here and
in both repository MCP configurations so every client loads the reviewed tool
release.

## Auth Failures

Missing or invalid tokens return `401` with `WWW-Authenticate: Bearer`. Tokens without the required tool scope return a tool-level insufficient-scope error.
