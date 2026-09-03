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

### CIMD token authentication negotiation

Dofek supports the public-client `none` token endpoint authentication method for CIMD. When a client metadata document includes `token_endpoint_auth_methods_supported`, Dofek selects `none` from that list and uses it even if the legacy singular `token_endpoint_auth_method` names another method. A document whose plural list excludes `none` is rejected. When the plural field is absent, Dofek preserves the legacy behavior: a missing singular field or `none` is accepted, while another singular method is rejected.

ChatGPT’s CIMD transition publishes the plural method list as capabilities and retains the singular field only as a legacy preference; it instructs authorization servers to select a method from the supported intersection. [OpenAI client registration guidance](https://developers.openai.com/plugins/build/auth/#client-registration) The applicable IETF CIMD draft defines URL-hosted client metadata, its exact client ID match, and how a client can declare `private_key_jwt` with a published JWKS when an authorization server supports that method. [IETF Client ID Metadata Document §4 and §8.2](https://datatracker.ietf.org/doc/draft-ietf-oauth-client-id-metadata-document/)

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
| `get_health_trends` | `health:read` | Returns a structured daily or weekly metric envelope with explicit no-data diagnostics, per-series coverage, and baseline-relative recovery context. |
| `get_data_coverage` | `health:read` | Returns first/last observed dates, observed-day counts, and providers for every supported health metric. |
| `render_health_explorer` | `health:read` | Returns a server-computed analytics snapshot and renders the Dofek Analytics Explorer in MCP clients that support Apps UI resources. |
| `get_sleep_summary` | `health:read` | Returns nightly sleep duration, efficiency, stages, and timing. |
| `search_activities` | `activity:read` | Searches activities inside exact date boundaries. |
| `get_activity_details` | `activity:read` | Returns one activity with its strength, climbing, and finger-loading details. |
| `get_activity_streams` | `activity:read` | Returns a capped, downsampled activity sensor stream with caller-selected channels. |
| `get_activity_summary` | `activity:read` | Aggregates activity volume and effort by type, ISO week, modality, or purpose, including unclassified and power coverage. |
| `get_cycling_performance` | `activity:read` | Returns exact-range per-ride normalized power, intensity factor, standard best efforts, rolling-90-day bests, FTP estimates, elevation, and coverage. |
| `get_training_load` | `activity:read` | Returns daily load, rolling 7-day acute load, rolling 28-day chronic load, and ACWR with window coverage. |
| `get_climbing_sessions` | `activity:read` | Returns exact-range climbing sessions with grades, attempts, sends, discipline, wall angle, and explicit unavailable fields. |
| `get_finger_loading` | `activity:read` | Returns structured finger-loading protocols, effective load, and total time under tension inside exact date boundaries. |
| `get_nutrition_summary` | `nutrition:read` | Returns daily calorie, macronutrient, fiber, and meal totals. |
| `get_body_metrics` | `health:read` | Returns one reconciled body-composition record per local date plus all per-source values. |
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

Requested health metrics are never silently omitted. A metric without samples in
the requested range is returned with `points: []`, `note: "no_data_in_range"`,
nullable summary values, and zero observed-day coverage. Missing daily points use
`null`; per-metric missing-date lists are capped at 30 with a separate truncated
count. The canonical behavior is implemented by the
[health-series builder](../packages/server/src/mcp/health-series-service.ts).

`get_body_metrics` reconciles weight, body-fat percentage, and BMI independently.
It first keeps the latest provider-attributed value for each metric and local
date, then selects the first non-null value by configured `body_priority`
(falling back to the general provider priority and then `100`). Its
`source_provider_by_metric` identifies each winner, while `sources` retains the
provider-level values and timestamps from provider-attributed raw samples. See the
[body repository](../packages/server/src/repositories/body-repository.ts).

`get_training_load` reads the canonical incremental `daily_strain` model. ACWR is
`null` until the 28-day chronic window is complete; each row reports the current
7-day and 28-day window coverage explicitly. See the
[daily-strain model](../analytics/models/read_models/daily_strain.sql) and
[training-load repository](../packages/server/src/repositories/training-load-repository.ts).

`get_cycling_performance` reads the deduped `cycling_activity` and
`activity_power_curve` models. Per-ride FTP is 95% of the best observed
20-minute effort in that ride's trailing 90-day window; intensity factor divides
normalized power by that contemporaneous estimate. Missing power remains
`null`, and both power and elevation aggregates report activity coverage. See the
[cycling-performance repository](../packages/server/src/repositories/cycling-performance-repository.ts).

`get_climbing_sessions` exposes the stored Kaya/file-import grade, attempt,
send, lead/top-rope, and wall-angle fields. Route height is not currently stored,
so `total_vertical_m` is explicitly `null`. `get_finger_loading` reports
effective load as `bodyweight_kg + external_load_kg` (a negative external load
represents assistance) and computes total time under tension as hold duration
times set count. See the [climbing repository](../packages/server/src/repositories/climbing-repository.ts)
and [finger-loading reader](../packages/server/src/repositories/climbing-training-log-repository.ts).

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
