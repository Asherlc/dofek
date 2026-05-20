# Remote MCP Server Design

## Goal

Expose Dofek data and a small set of user-scoped actions through a remote Model Context Protocol server hosted by the existing Dofek Express server.

## Scope

The first version supports per-user authenticated access to:

- Read daily health summaries.
- Search activity history.
- Log nutrition entries.
- List connected providers.
- Start provider sync jobs.

The first version does not implement a full OAuth 2.1 authorization server, dynamic client registration, a Cloudflare Worker proxy, raw SQL tools, broad provider mutation tools, or a separate MCP deployment.

## Architecture

Add MCP support inside `packages/server` and mount it at `/api/mcp`. The route handles MCP protocol transport and request authentication. Tool definitions and tool implementations live under `packages/server/src/mcp/`, separate from route wiring.

Use `@modelcontextprotocol/sdk` as the single MCP implementation dependency. The server uses the SDK's Streamable HTTP transport because this is the current remote MCP transport and avoids maintaining protocol details by hand. Do not add `tmcp` or another MCP framework in parallel.

Tool implementations call existing server repositories, queues, and domain helpers. They should not duplicate business rules already owned by tRPC routers or repositories. When existing write behavior is locked inside a router, extract a small production helper only if that helper improves the production boundary and is not exported solely for tests.

## Authentication

Use dedicated MCP bearer tokens instead of full OAuth in the first version.

Add a new `fitness.mcp_access_token` table with:

- `id uuid primary key`
- `user_id uuid not null references fitness.user_profile(id) on delete cascade`
- `name text not null`
- `token_hash text not null unique`
- `scopes text[] not null`
- `created_at timestamptz not null default now()`
- `last_used_at timestamptz`
- `expires_at timestamptz`
- `revoked_at timestamptz`

Users create and revoke MCP tokens through authenticated Dofek UI/API flows. The server returns the raw token only once at creation time. Persist only a hash. Token generation should use Node crypto randomness and a recognizable prefix such as `dofek_mcp_`.

Every MCP request must include `Authorization: Bearer <token>`. The route validates the token hash, confirms it is not expired or revoked, loads `userId` and scopes, updates `last_used_at`, and builds the MCP context.

Missing or invalid tokens return `401` with a `WWW-Authenticate: Bearer` header. Valid tokens missing a required scope return a tool-level JSON-RPC error over the MCP Streamable HTTP response, which remains HTTP `200` per the SDK transport behavior. Do not fall back to cookies or query-string sessions for MCP.

Initial scopes:

- `health:read`
- `activity:read`
- `nutrition:write`
- `providers:read`
- `sync:write`

## Tools

### `get_daily_health_summary`

Scope: `health:read`

Input:

- `date`: ISO date string.
- `timezone`: optional IANA timezone string.

Returns a compact summary of the user's day using server-computed metrics. The MCP tool must not compute metrics client-side or derive values from raw records in a way that bypasses existing server-owned logic.

### `search_activities`

Scope: `activity:read`

Input:

- `from`: optional ISO date string.
- `to`: optional ISO date string.
- `query`: optional string.
- `limit`: optional integer with a small maximum.

Returns matching activity summaries for the authenticated user. The tool should use existing activity repository behavior where practical and keep output concise enough for agent use.

### `log_food`

Scope: `nutrition:write`

Input:

- `text`: natural-language meal description.
- `occurredAt`: optional ISO datetime.
- `mealType`: optional meal type if the existing nutrition path supports it.

Creates food entries through the canonical server-side nutrition path. If the existing path supports AI itemization cleanly, use it; otherwise start with the minimal direct logging path and do not add a second nutrition model.

### `list_providers`

Scope: `providers:read`

Input: none.

Returns configured and connected provider status for the authenticated user. Disabled providers remain hidden if current provider validation hides them.

### `start_provider_sync`

Scope: `sync:write`

Input:

- `providerId`: provider identifier.

Enqueues the same user-scoped provider sync job used by the web UI and returns job id plus status. Do not run sync inline inside the MCP request.

## Error Handling and Observability

All unexpected MCP route and tool errors are reported to Sentry. Tool errors returned to clients should be specific and actionable, matching existing server behavior. Avoid generic "something went wrong" messages when the failure is known.

MCP requests should be logged with method, path, status, duration, user id when authenticated, tool name when available, and failure category. Do not log raw bearer tokens or full nutrition text payloads.

## Testing

Follow TDD.

Add unit tests for:

- Token generation shape.
- Token hashing and lookup.
- Expiry checks.
- Revocation checks.
- Scope checks.

Add route tests for:

- Missing bearer token returns `401`.
- Invalid bearer token returns `401`.
- Valid token missing scope returns a tool-level insufficient-scope error in the MCP response.
- Valid token can make at least one MCP request through `/api/mcp`.

Add focused tests for each tool through the public MCP route where practical. Repository-heavy paths may use existing repository tests or integration tests with the local database.

Do not add tests for static config files.

## Documentation

Update docs with:

- How to create and revoke an MCP token.
- How to connect a remote MCP client to `/api/mcp`.
- An example using `mcp-remote` for clients that need a local bridge.
- The initial tool list and scopes.

Mention `@modelcontextprotocol/inspector` as the manual verification tool, but do not make it a production dependency.

## Rollout

Add the schema migration manually and run `pnpm migrate` after creating it. Add the dependency at its latest stable version at implementation time. Keep the implementation inside the existing server deployment. Do not add a Cloudflare Worker or full OAuth server in this iteration.
