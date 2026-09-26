# Migrate Dofek MCP Server to v2 SDK + oidc-provider Authorization Server

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the Dofek MCP server off `@modelcontextprotocol/sdk@1.30.0` onto the v2 package ecosystem, replace the hand-rolled OAuth authorization server with `oidc-provider` (panva) as a dedicated IdP, and thereby obtain RFC 9207 issuer identification (`iss`) — the capability ChatGPT's MCP Apps "Connect" flow requires before it advances from OAuth discovery to `/authorize`.

**Architecture:** v2 split the MCP stack and **removed** the OAuth authorization-server router from the main `server` package (v2 expects a dedicated IdP). Rather than reimplement the AS (or use the deprecated `server-legacy`), adopt **`oidc-provider`** — a battle-tested OAuth 2.1/OIDC server that natively implements PKCE, DCR (RFC 7591), resource indicators (RFC 8707), issuer identification (RFC 9207), CIMD (draft-02), and refresh-token rotation. Dofek keeps (a) the v2 `@modelcontextprotocol/server`+`node` layer for the MCP protocol/tools/transport, (b) the RFC 9728 protected-resource metadata (resource-server role), and (c) its Postgres persistence + session/account/consent integrations, now mapped onto `oidc-provider`'s adapter/`findAccount`/interactions surface.

**Tech Stack:** TypeScript, Express 5, `@modelcontextprotocol/core@2.1.0`, `@modelcontextprotocol/server@2.1.0`, `@modelcontextprotocol/node@2.1.0`, `@modelcontextprotocol/ext-apps@2.0.3`, `oidc-provider@9.12.2`, Zod 4, Drizzle ORM, Vitest. **Do NOT** adopt `@modelcontextprotocol/server-legacy`; **remove** `@modelcontextprotocol/sdk`.

---

## Evidence and root cause (verified; do not re-derive)

1. `GET /.well-known/oauth-protected-resource/api/mcp` → 200 (correct `authorization_servers`).
2. `GET /.well-known/oauth-authorization-server` → 200, **missing `authorization_response_iss_parameter_supported`**.
3. Production `dofek_web` logs: ChatGPT fetches both discovery docs (200) then **never issues `/authorize`** — aborts client-side during client-identification (CIMD) before consent, surfacing "Couldn't create MCP app. Try again."
4. ChatGPT CIMD (`https://chatgpt.com/oauth/client.json`) → `token_endpoint_auth_methods_supported: ["none","private_key_jwt"]`.
5. `server-legacy@2.1.0` is **deprecated** ("frozen copy … for migration purposes only … Will not receive new features").
6. `oidc-provider@9.12.2` (updated 2026-09-05) natively supports DCR (RFC 7591), resource indicators (RFC 8707), **issuer identification (RFC 9207)**, and **CIMD draft-02** — every AS capability Dofek currently hand-rolls.

**Root cause:** ChatGPT reads Dofek's AS metadata, finds no issuer-identification support, selects the callback-ID redirect path, and aborts before `/authorize`.

---

## Final dependency target

| Current | Target |
|---|---|
| `@modelcontextprotocol/sdk@1.30.0` | **remove** |
| `@modelcontextprotocol/ext-apps@1.7.5` | `@modelcontextprotocol/ext-apps@2.0.3` |
| (none) | `@modelcontextprotocol/core@2.1.0` |
| (none) | `@modelcontextprotocol/server@2.1.0` |
| (none) | `@modelcontextprotocol/node@2.1.0` |
| (none) | `oidc-provider@9.12.2` |
| (none) | `@modelcontextprotocol/server-legacy` — **do not add** |

---

## Task 0: Revert the hand-rolled AS scaffolding (from the aborted Task 2)

Dofek will adopt `oidc-provider` instead of owning `/authorize`+`/token`+`/register`+`/revoke`. Some of the Task 2 output is obsolete.

**Files:**
- Delete: `packages/server/src/mcp/oauth-authorize-handler.ts`, `oauth-token-handler.ts`, `oauth-register.ts`, `oauth-revoke.ts` (and their tests).
- Keep: `oauth-metadata.ts` (the RFC 9728 PRM builder + `getOAuthProtectedResourceMetadataUrl` — this is the resource-server role and stays Dofek-owned).
- Revert: `oauth-route.ts` to remove the wiring of the deleted handlers (keep the session-gate + CIMD `/oauth-client` routes and metadata routes for now; `oidc-provider` will own `/authorize`/`/token`/`/register`/`/revoke` in Task 2).

- [ ] **Step 1: Delete the four hand-rolled EPUB handlers and their tests**
- [ ] **Step 2: Restore `oauth-route.ts` to a clean state** (drop now-dead imports/wiring; keep session gate, metadata, CIMD read endpoint).
- [ ] **Step 3: Verify typecheck is no worse than pre-Task-2** (`pnpm tsc --noEmit` in `packages/server`; only the pre-existing `app-resource.ts` errors remain).
- [ ] **Step 4: Commit**

```bash
git add packages/server/src/mcp/
git commit -m "revert(mcp): drop hand-rolled OAuth AS handlers in favor of oidc-provider"
```

---

## Task 1: Add `oidc-provider` dependency

**Files:**
- Modify: `packages/server/package.json`

- [ ] **Step 1: Add `"oidc-provider": "9.12.2"` to `packages/server/package.json` dependencies**
- [ ] **Step 2: `pnpm install`** and confirm `oidc-provider` resolves (it pulls its own deps; no peer conflicts with Express 5).
- [ ] **Step 3: Commit**

```bash
git add packages/server/package.json pnpm-lock.yaml
git commit -m "chore(server): add oidc-provider for MCP OAuth authorization server"
```

---

## Task 2: Stand up `oidc-provider` as the MCP Authorization Server

Configure `oidc-provider` with Dofek's issuer, scopes, features, and persistence.

**Files:**
- Create: `packages/server/src/mcp/oidc/config.ts` (provider instantiation)
- Create: `packages/server/src/mcp/oidc/adapter.ts` (Postgres persistence mapping `fitness.mcp_oauth_client`/`_authorization_code`/`_access_token`/`_refresh_token` — or new oidc tables)
- Create: `packages/server/src/mcp/oidc/account.ts` (`findAccount` from Dofek session/user)
- Create: `packages/server/src/mcp/oidc/interactions.ts` (consent UI reusing existing consent markup)
- Modify: `packages/server/src/mcp/oauth-config.ts` (issuer/resource URLs reused)

- [ ] **Step 1: Configure `oidc-provider`** with:
  - `issuer: getMcpIssuerUrl().href`
  - `features`: enable `registration` (e.g. `{ enabled: true, initialAccessToken: false }`), `resourceIndicators` (`{ enabled: true, defaultResource: ... , getResourceServerInfo }`), `dPoP`, `ciba`/`deviceFlow` off.
  - `scopes`: the Dofek MCP scopes (`health:read`, `health:write`, `activity:read`, `nutrition:read`, `nutrition:write`, `providers:read`, `sync:write`, `offline_access`) preserving `MCP_OAUTH_SUPPORTED_SCOPES`.
  - `clientBasedCORS`, `ttl`, `cookies`, `renderError`, `routes`.
- [ ] **Step 2: Implement the `adapter`** against Postgres (Dofek's `fitness.mcp_*` tables or new oidc-specific tables) — returning stable, expirable records for Client, AuthorizationCode, AccessToken, RefreshToken, Session.
- [ ] **Step 3: Implement `findAccount`** resolving Dofek's session cookie → `accountId`/claims (reuse `getSessionIdFromRequest`/`validateSession`).
- [ ] **Step 4: Register the CIMD client as a `client_id` document** so ChatGPT's `https://chatgpt.com/oauth/client.json` resolves: Dofek already resolves CIMD via `oauth-client-metadata.ts`; adapt that resolver to oidc-provider's `extraClientMetadata`/`findById` or `client_id` URL handling.
- [ ] **Step 5: Mount the provider** at the AS paths (replacing the deleted hand-rolled handlers) in `oauth-route.ts`, behind the existing session gate.
- [ ] **Step 6: Keep Dofek-owned RFC 9728 PRM** (`oauth-metadata.ts`) pointing `authorization_servers` at the oidc-provider issuer.

- [ ] **Step 7: Write tests** (unit + integration) asserting: metadata advertises `authorization_response_iss_parameter_supported` (oidc-provider emits it given RFC 9207), DCR works, PKCE flow issues tokens, CIMD `client_id` resolves, `/authorize` success+error redirects carry `iss`.

- [ ] **Step 8: Commit**

```bash
git add packages/server/src/mcp/
git commit -m "feat(mcp): serve OAuth authorization server via oidc-provider"
```

---

## Task 3: Adopt v2 `McpServer` + `registerTool` for tools

**Files:**
- Modify: `packages/server/src/mcp/tools.ts`, all `*-tool.ts` (26 files), `app-resource.ts`, `request-telemetry.ts`

- [ ] **Step 1:** Repoint `McpServer` type imports from `@modelcontextprotocol/sdk/server/mcp.js` → `@modelcontextprotocol/server`; `SUPPORTED_PROTOCOL_VERSIONS` likewise.
- [ ] **Step 2:** Rewrite `createDofekMcpServer` to the v2 `McpServer`/`McpServerFactory`; re-register every tool preserving name/desc/schemas/annotations exactly.
- [ ] **Step 3:** Migrate `app-resource.ts` (`registerAppResource` from `@modelcontextprotocol/ext-apps/server` 2.x).
- [ ] **Step 4:** `pnpm tsc --noEmit` + unit suite + commit.

---

## Task 4: Adopt v2 streamable-HTTP transport + resource-server auth

**Files:**
- Modify: `packages/server/src/mcp/route.ts`
- Modify: `packages/server/src/mcp/oidc/config.ts` (token format)

**Decision (confirmed): JWT access tokens + JWKS verification.** Cleanest, stateless, standards-aligned: oidc-provider signs `accessTokenFormat: "jwt"`; the resource server verifies signature+`exp`+`aud`+scopes against oidc-provider's `/jwks`. No per-request introspection or dual token-store coupling. Manual "personal tokens" keep Dofek's own opaque `validateMcpToken` path.

- [ ] **Step 1:** In `oidc/config.ts` `getResourceServerInfo`, return `accessTokenFormat: "jwt"` (instead of `"opaque"`), keeping `audience: resourceUrl` + 1h TTL.
- [ ] **Step 2:** Replace `StreamableHTTPServerTransport` with `@modelcontextprotocol/node` transport.
- [ ] **Step 3:** Replace hand-rolled bearer validation with `verifyBearerToken` from `@modelcontextprotocol/server`, whose verifier parses the JWT, checks `aud === resourceUrl`, `exp`, required scopes, and signature against oidc-provider's `/jwks` (cached, rotating). Keep the Dofek-native personal-token path via `validateMcpToken` for `oauth_client_id IS NULL` tokens.
- [ ] **Step 4:** Keep the 401 `WWW-Authenticate: Bearer resource_metadata=...` challenge + telemetry; run route tests; commit.

---

## Task 5: Remove v1 sdk + Ziva client migration + docs

**Files:**
- Modify: `src/providers/ziva/client.ts` (v1 MCP *client* → `@modelcontextprotocol/client`), root `package.json`
- Modify: `docs/mcp.md`, `docs/production-incident-baseline.md`

- [ ] **Step 1:** Migrate Ziva's MCP client to `@modelcontextprotocol/client@2.x`, then remove `@modelcontextprotocol/sdk` from the root `package.json`.
- [ ] **Step 2:** `rg '@modelcontextprotocol/sdk'` empty across source; `pnpm install`.
- [ ] **Step 3:** Full `pnpm lint`, `pnpm test:unit`, `pnpm tsc --noEmit`.
- [ ] **Step 4:** MCP Inspector end-to-end: confirm `authorization_response_iss_parameter_supported: true` + `iss` on redirects.
- [ ] **Step 5:** Document; commit.

---

## Self-review notes

- **`iss` now comes free from oidc-provider** — do NOT hand-append `iss`; verify oidc-provider emits it (it does, per RFC 9207 support) and that the resource-server side validates audience.
- **Persistence adapter** is the riskiest integration; prefer new oidc-owned tables unless Dofek's existing `fitness.mcp_*` schema maps cleanly (a migration may be needed).
- **CIMD** is the second risk; oidc-provider supports CIMD draft-02 — confirm ChatGPT's `private_key_jwt`-preferring CIMD intersects (`none`/`private_key_jwt`) correctly.
- **PRM stays Dofek-owned** (resource-server role); only `authorization_servers` points at oidc-provider.
- **`MCP_OIDC_COOKIE_KEY`** (new) must be added to Infisical before deploy — see `oidc/config.ts`.
- **Dead code cleanup:** `oauth-provider.ts` (`DofekOAuthServerProvider`) and `oauth-metadata.ts` (`createOAuthMetadata`) are now unwired; delete them + their unit tests in Task 5 once the resource-server no longer imports them.
- **`renderError`** in `oidc/config.ts` interpolates `error.message` unescaped — fix to HTML-escape before merge.