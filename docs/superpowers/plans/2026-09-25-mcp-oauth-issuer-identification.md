# Migrate Dofek MCP Server from `@modelcontextprotocol/sdk` v1 to v2

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the Dofek MCP server off `@modelcontextprotocol/sdk@1.30.0` onto the v2 MCP package ecosystem so that the authorization server natively supports RFC 9207 issuer identification (`iss`), which ChatGPT's MCP Apps "Connect" flow requires before it will advance from OAuth discovery to `/authorize`.

**Architecture:** The v1 SDK's `mcpAuthRouter`/`authorizationHandler` do not emit `authorization_response_iss_parameter_supported` or echo `iss` on authorization redirects; ChatGPT aborts connection with "Couldn't create MCP app. Try again." after discovery. The v2 SDK split this capability across four packages (`@modelcontextprotocol/core`, `@modelcontextprotocol/server`, `@modelcontextprotocol/node`, `@modelcontextprotocol/server-legacy`), where `server-legacy`'s `mcpAuthRouter` advertises the flag (default `true`) and its `authorizationHandler` appends `iss` to every redirect to the validated `redirect_uri`. This migration adopts the v2 packages and their `registerTool`/transport APIs.

**Tech Stack:** TypeScript, Express, `@modelcontextprotocol/server@2.1.0`, `@modelcontextprotocol/node@2.1.0`, `@modelcontextprotocol/core@2.1.0`, `@modelcontextprotocol/server-legacy@2.1.0`, Zod, Drizzle ORM, Vitest.

---

## Evidence and root cause (do not re-derive)

Verified empirically (live `https://dofek.fit` and production Swarm logs) and against SDK `1.30.0`/`1.30.1`/`2.1.0` sources (`npm pack`):

1. `GET /.well-known/oauth-protected-resource/api/mcp` → 200, correct `authorization_servers: ["https://dofek.fit/"]`.
2. `GET /.well-known/oauth-authorization-server` → 200, **missing `authorization_response_iss_parameter_supported`**.
3. Production `dofek_web` logs show ChatGPT fetches both discovery documents (200) then **never issues `GET /authorize`** — it aborts client-side during client-identification (CIMD/DCR) before the consent screen.
4. ChatGPT's CIMD documents (`https://chatgpt.com/oauth/client.json`, `.../connector/client.json`) publish `token_endpoint_auth_methods_supported: ["none","private_key_jwt"]` with singular legacy preference `private_key_jwt`.
5. The MCP spec (2025-11-25) does **not** require `iss`. It is an OpenAI-specific requirement layered on top. SDK v1 (`@modelcontextprotocol/sdk`) does not implement it; only the v2 `server-legacy` package does.

**Root cause:** ChatGPT's connect flow reads Dofek's authorization-server metadata, finds no issuer-identification support, falls back to the callback-ID redirect path, and aborts before `/authorize`, surfacing "Couldn't create MCP app. Try again."

---

## Package mapping (verified against 2.1.0 dist)

| v1.30 usage (`@modelcontextprotocol/sdk/...`) | v2 target |
|---|---|
| `server/mcp.js` → `McpServer`, `registerTool` | `@modelcontextprotocol/server` → `McpServer` (new API, `McpServerFactory`, `ToolCallback`) |
| `server/streamableHttp.js` → `StreamableHTTPServerTransport` | `@modelcontextprotocol/node` → `StreamableHTTPServerTransport` (Node), backed by `server`'s `WebStandardStreamableHTTPServerTransport` |
| `server/auth/router.js` → `mcpAuthRouter`, `createOAuthMetadata`, `getOAuthProtectedResourceMetadataUrl` | `@modelcontextprotocol/server-legacy` → same names, plus `iss` support |
| `server/auth/{provider,clients,errors}.js`, `shared/auth.js` | `@modelcontextprotocol/server-legacy` / `@modelcontextprotocol/core` (schemas) |
| `types.js` → `SUPPORTED_PROTOCOL_VERSIONS` | `@modelcontextprotocol/server` → `SUPPORTED_PROTOCOL_VERSIONS` |

The `McpServer` and tool-registration APIs are a **ground-up rewrite** (not a rename): `registerTool` now uses `ToolCallback` with `inputSchema`/`outputSchema`/`annotations`, and the transport model uses Web Standard Request/Response via `createMcpHandler`. This is why the migration must be planned and sequenced, not done as a mechanical find-and-replace.

---

## Task 1: Add the v2 dependencies and pin versions

**Files:**
- Modify: `packages/server/package.json`
- Modify: `pnpm-workspace.yaml` (only if required for resolution)

- [ ] **Step 1: Record current dependency**

Read `packages/server/package.json` and note the exact current `@modelcontextprotocol/sdk` entry (expected `1.30.0` / `^1.30.0`) and any `@modelcontextprotocol/ext-apps` entry (`1.7.5`).

- [ ] **Step 2: Add v2 packages**

Add, using the latest stable versions resolved today:

```jsonc
"@modelcontextprotocol/core": "2.1.0",
"@modelcontextprotocol/node": "2.1.0",
"@modelcontextprotocol/server": "2.1.0",
"@modelcontextprotocol/server-legacy": "2.1.0"
```

Keep `@modelcontextprotocol/sdk` and `@modelcontextprotocol/ext-apps` for now (they are removed in later tasks, once `.mcp.json`/`ext-apps` consumers are migrated or confirmed out of scope).

- [ ] **Step 3: Install and lock**

Run: `pnpm install`

Expected: completes with the four new packages added to `pnpm-lock.yaml`.

- [ ] **Step 4: Commit**

```bash
git add packages/server/package.json pnpm-lock.yaml
git commit -m "chore(server): add v2 MCP SDK packages for iss support"
```

---

## Task 2: Migrate OAuth router + metadata to `server-legacy` (the actual `iss` fix)

**Files:**
- Modify: `packages/server/src/mcp/oauth-route.ts`
- Modify: `packages/server/src/mcp/oauth-route.test.ts`

- [ ] **Step 1: Verify `server-legacy` exports match current imports**

Run: `node -e "const p=require('@modelcontextprotocol/server-legacy'); console.log(['createOAuthMetadata','mcpAuthRouter','getOAuthProtectedResourceMetadataUrl','authorizationHandler','redirectUriMatches'].map(k => [k, typeof p[k]]))"`

Expected: all five are functions.

- [ ] **Step 2: Repoint imports**

In `oauth-route.ts`, replace the import:
```ts
import { createOAuthMetadata, mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
```
with:
```ts
import { createOAuthMetadata, mcpAuthRouter } from "@modelcontextprotocol/server-legacy";
```
and in `oauth-provider.ts`/`oauth-provider.ts`-adjacent auth files (see Task 3), repoint `server/auth/*.js` imports to `@modelcontextprotocol/server-legacy` (single entry) or `@modelcontextprotocol/core` for shared auth schemas.

- [ ] **Step 3: Remove the manual `authorization_response_iss_parameter_supported` flag if the router already advertises it**

In `oauth-route.ts`, `createOAuthMetadata(oauthRouterOptions)` now returns metadata; check whether `mcpAuthRouter` emits `authorization_response_iss_parameter_supported` automatically (it does in `server-legacy` when `provider.authorizationResponseIssParameterSupported ?? true`). If auto-emitted, delete the explicit `authorization_response_iss_parameter_supported: true` line and its test assertion; otherwise keep it.

- [ ] **Step 4: Run the oauth-route unit tests**

Run: `cd packages/server && pnpm vitest run --project unit src/mcp/oauth-route.test.ts`

Expected: pass; specifically the metadata test still asserts `authorization_response_iss_parameter_supported === true`.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/mcp/oauth-route.ts packages/server/src/mcp/oauth-route.test.ts
git commit -m "feat(mcp): advertise RFC 9207 issuer identification via server-legacy"
```

---

## Task 3: Migrate the OAuth provider, client store, and token types

**Files:**
- Modify: `packages/server/src/mcp/oauth-provider.ts`
- Modify: `packages/server/src/mcp/oauth-client-store.ts`
- Modify: `packages/server/src/mcp/oauth-client-resolver.ts`
- Modify: `packages/server/src/mcp/oauth-client-metadata.ts`

- [ ] **Step 1: Repoint auth imports**

Replace all `@modelcontextprotocol/sdk/server/auth/{errors,clients,provider,types}.js` and `@modelcontextprotocol/sdk/shared/auth.js` imports with the v2 equivalents:
- types/errors/store provider interfaces: `@modelcontextprotocol/server-legacy`
- shared auth schemas (`OAuthClientInformationFull`, `OAuthClientMetadataSchema`, etc.): `@modelcontextprotocol/core`

- [ ] **Step 2: Verify `AuthorizationParams` gained an `issuer` field (used by the `iss` mechanism)**

`server-legacy`'s `AuthorizationParams` now includes `issuer?: string`. Confirm `DofekOAuthServerProvider.authorize()` still type-checks; it may ignore the new field (the router appends `iss` via its redirect wrapper), so the manual `iss` added to `oauth-provider.ts` in the interim should be **removed** to avoid a duplicate-`iss` risk.

- [ ] **Step 3: Run provider + client tests**

Run: `cd packages/server && pnpm vitest run --project unit src/mcp/oauth-provider.test.ts src/mcp/oauth-client-store.test.ts src/mcp/oauth-client-resolver.test.ts src/mcp/oauth-client-metadata.test.ts`

Expected: pass.

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/mcp/oauth-provider.ts packages/server/src/mcp/oauth-client-store.ts packages/server/src/mcp/oauth-client-resolver.ts packages/server/src/mcp/oauth-client-metadata.ts
git commit -m "refactor(mcp): migrate OAuth provider to v2 auth types"
```

---

## Task 4: Migrate `McpServer` and tool registration to v2 `@modelcontextprotocol/server`

This is the largest task. `tools.ts` constructs `McpServer` and registers ~30 tools; 24 tool files re-export a typed `McpServer`.

**Files:**
- Modify: `packages/server/src/mcp/tools.ts`
- Modify: `packages/server/src/mcp/app-resource.ts` and every `*-tool.ts` / `tools` helper that imports `McpServer`
- Modify: `packages/server/src/mcp/request-telemetry.ts` (`SUPPORTED_PROTOCOL_VERSIONS` import)

- [ ] **Step 1: Enumerate the exact import sites**

Run: `rg -n "server/mcp\.js|McpServer|SUPPORTED_PROTOCOL_VERSIONS" packages/server/src/mcp --glob '*.ts' | grep -v '\.test\.ts'`

Expected: ~26 files importing `McpServer`, 1 importing `SUPPORTED_PROTOCOL_VERSIONS`. Record the list.

- [ ] **Step 2: Learn the v2 `McpServer` registration signature**

Read `node_modules/@modelcontextprotocol/server/dist/index.d.mts` for `McpServer.registerTool` and `ToolCallback`. Confirm the new signature (name, `{ title, description, inputSchema, outputSchema, annotations, _meta }`, callback). Do not guess — this is the crux of the rewrite.

- [ ] **Step 3: Migrate `tools.ts` construction**

Rewrite `createDofekMcpServer` to use the v2 `McpServer`/`McpServerFactory` constructor and re-register each tool. Preserve every current tool's name, description, `inputSchema`, `outputSchema`, and annotations exactly (the ChatGPT submission contract depends on these). Update the `McpServer` type re-export so the 24 tool files continue to type-check.

- [ ] **Step 4: Repoint `request-telemetry.ts`**

Replace `import { SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js"` with `import { SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/server"`.

- [ ] **Step 5: Typecheck**

Run: `cd packages/server && pnpm tsc --noEmit`

Expected: no type errors. Iterate on any `registerTool`/`McpServer` signature mismatches.

- [ ] **Step 6: Run the mcp unit suite**

Run: `cd packages/server && pnpm vitest run --project unit src/mcp/`

Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/mcp/tools.ts packages/server/src/mcp/request-telemetry.ts packages/server/src/mcp/
git commit -m "refactor(mcp): migrate McpServer and tool registration to v2"
```

---

## Task 5: Migrate the streamable-HTTP transport

**Files:**
- Modify: `packages/server/src/mcp/route.ts`

- [ ] **Step 1: Repoint the transport**

Replace `import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"` with the v2 Node transport from `@modelcontextprotocol/node` (its `StreamableHTTPServerTransport` wrapping `WebStandardStreamableHTTPServerTransport`).

- [ ] **Step 2: Adapt the request handler**

The v2 transport uses Web Standard request/response or a `createMcpHandler` bridge rather than `transport.handleRequest(request, response, body)` directly. Rework `createMcpRouter`'s POST path (`route.ts:219-221`) accordingly, preserving the existing telemetry (`mcp.request`, `mcp.tools_list`), session/scope guards, and `StreamableHTTPServerTransport` `sessionIdGenerator: undefined` semantics.

- [ ] **Step 3: Run route tests**

Run: `cd packages/server && pnpm vitest run --project unit src/mcp/route.test.ts src/mcp/route-lifecycle.test.ts`

Expected: pass. This is the highest-risk task; the route tests are comprehensive (4971 lines) and will catch regressions.

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/mcp/route.ts
git commit -m "refactor(mcp): migrate streamable-HTTP transport to v2 node transport"
```

---

## Task 6: Remove the v1 SDK, final validation, and docs

**Files:**
- Modify: `packages/server/package.json` (remove `@modelcontextprotocol/sdk` if no consumers remain)
- Modify: `docs/mcp.md` (note the `iss`/issuer-identification support and v2 SDK)
- Modify: `docs/production-incident-baseline.md` (append the connect-failure incident)

- [ ] **Step 1: Confirm no remaining v1 imports**

Run: `rg -n "@modelcontextprotocol/sdk" packages/server/src --glob '*.ts' | grep -v '\.test\.ts'`

Expected: empty (or only `ext-apps`, which is out of scope). If `ext-apps` remains, keep `@modelcontextprotocol/sdk` only as its peer.

- [ ] **Step 2: Remove the v1 dependency if unused**

Remove `@modelcontextprotocol/sdk` from `packages/server/package.json` only when no source import remains, then run `pnpm install`.

- [ ] **Step 3: Full pre-push checks**

Run: `pnpm lint`, then `pnpm test:unit`, then `pnpm tsc --noEmit` and `cd packages/server && pnpm tsc --noEmit`.

Expected: all green.

- [ ] **Step 4: Verify end-to-end against a real server**

Follow `docs/mcp.md` "Manual Verification" with the MCP Inspector, and confirm the `/.well-known/oauth-authorization-server` now returns `authorization_response_iss_parameter_supported: true` and that `/authorize` redirects carry `iss=https://dofek.fit/` on both success and error.

- [ ] **Step 5: Document and commit**

Update `docs/mcp.md` (authorization flow now supports issuer identification) and append the incident note, then:

```bash
git add packages/server/package.json pnpm-lock.yaml docs/mcp.md docs/production-incident-baseline.md
git commit -m "docs(mcp): document RFC 9207 issuer identification and v2 SDK migration"
```

---

## Self-review notes

- **Dependency risk:** Task 4 and Task 5 are the hard parts (API rewrite, not import swap). Verify signatures from installed `.d.mts` at each step; do not assume.
- **`ext-apps` (`@modelcontextprotocol/ext-apps@1.7.5`)**: if it peers on `@modelcontextprotocol/sdk`, the v1 package must remain installed until it is migrated or removed. Confirm before removing.
- **Minimal-force fallback:** if Tasks 4-5 reveal an unbounded v2 rewrite, the proportionate interim fix is the ~25-line `res.redirect` wrapper on v1.30 (mirrors upstream's own `withIssOnCallbackRedirect`), with one documented lint suppression. Pause and ask before switching to it.