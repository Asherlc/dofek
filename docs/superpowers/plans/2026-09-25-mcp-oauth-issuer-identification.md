# Migrate Dofek MCP Server from SDK v1 to v2 (with standalone OAuth AS)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the Dofek MCP server off `@modelcontextprotocol/sdk@1.30.0` onto the v2 package ecosystem, decouple Dofek's own OAuth authorization server from any SDK, and thereby gain RFC 9207 issuer identification (`iss`) — the capability ChatGPT's MCP Apps "Connect" flow requires before it advances from OAuth discovery to `/authorize`.

**Architecture:** v2 split the MCP stack into four packages (`core`, `server`, `node`, `server-legacy`) and **removed** the OAuth authorization-server router from the main `server` package (v2 expects a dedicated IdP). Dofek already owns a complete OAuth AS (`oauth-*.ts` + `oauth-repository.ts`: `/authorize`, `/token`, `/register`, `/revoke`, CIMD, PKCE, Postgres client/token store). This migration (**a**) keeps that AS but reimplements its thin SDK-derived routing scaffolding (`mcpAuthRouter`/`authorizationHandler`/`createOAuthMetadata`/`createErrorRedirect`) in Dofek's own code so the AS is standalone, and (**b**) adopts v2 `server`+`node` for the MCP protocol/tool/transport layer and for resource-server token verification + protected-resource metadata. The AS emits `authorization_response_iss_parameter_supported: true` and echoes `iss` on every authorization redirect — the actual bug fix.

**Tech Stack:** TypeScript, Express 5, `@modelcontextprotocol/core@2.1.0`, `@modelcontextprotocol/server@2.1.0`, `@modelcontextprotocol/node@2.1.0`, `@modelcontextprotocol/ext-apps@2.0.3`, Zod 4, Drizzle ORM, Vitest. **Do NOT** adopt `@modelcontextprotocol/server-legacy` (deprecated, frozen, v3-removal); **remove** `@modelcontextprotocol/sdk`.

---

## Evidence and root cause (verified; do not re-derive)

1. `GET /.well-known/oauth-protected-resource/api/mcp` → 200 (correct `authorization_servers`).
2. `GET /.well-known/oauth-authorization-server` → 200, **missing `authorization_response_iss_parameter_supported`**.
3. Production `dofek_web` logs: ChatGPT fetches both discovery docs (200) then **never issues `/authorize`** — it aborts client-side during client-identification (CIMD) before the consent screen, surfacing "Couldn't create MCP app. Try again."
4. ChatGPT CIMD (`https://chatgpt.com/oauth/client.json`) → `token_endpoint_auth_methods_supported: ["none","private_key_jwt"]`, singular legacy preference `private_key_jwt`.
5. `server-legacy@2.1.0` is **deprecated**: "frozen copy of v1 ... for migration purposes only. Use StreamableHTTP from @modelcontextprotocol/server and a dedicated OAuth server in production. Will not receive new features."

**Root cause:** ChatGPT reads Dofek's AS metadata, finds no issuer-identification support, selects the callback-ID redirect path, and aborts before `/authorize`.

---

## Final dependency target

| Current | Target |
|---|---|
| `@modelcontextprotocol/sdk@1.30.0` | **remove** |
| `@modelcontextprotocol/ext-apps@1.7.5` | `@modelcontextprotocol/ext-apps@2.0.3` |
| — | `@modelcontextprotocol/core@2.1.0` |
| — | `@modelcontextprotocol/server@2.1.0` |
| — | `@modelcontextprotocol/node@2.1.0` |
| — | `@modelcontextprotocol/server-legacy` (**do not add**) |

---

## Task 1: Swap dependencies to v2

**Files:**
- Modify: `packages/server/package.json`

- [ ] **Step 1: Edit dependencies**

In `packages/server/package.json`, change:
```jsonc
"@modelcontextprotocol/ext-apps": "1.7.5",
"@modelcontextprotocol/sdk": "1.30.0",
```
to:
```jsonc
"@modelcontextprotocol/core": "2.1.0",
"@modelcontextprotocol/ext-apps": "2.0.3",
"@modelcontextprotocol/node": "2.1.0",
"@modelcontextprotocol/server": "2.1.0",
```

- [ ] **Step 2: Install and lock**

Run: `pnpm install`

Expected: the four v2 packages resolve; `@modelcontextprotocol/sdk` is removed from the lockfile (unless another workspace still references it — verify with `rg '"@modelcontextprotocol/sdk"' pnpm-lock.yaml` and `rg 'import.*@modelcontextprotocol/sdk' --glob '!node_modules'` across the repo).

- [ ] **Step 3: Commit**

```bash
git add packages/server/package.json pnpm-lock.yaml
git commit -m "chore(server): adopt v2 MCP SDK packages, drop v1 sdk"
```

---

## Task 2: Reimplement the OAuth AS scaffolding in Dofek's own code (emits `iss`)

The v1 SDK's `mcpAuthRouter`/`authorizationHandler`/`createOAuthMetadata` no longer exist in v2; the AS must own them. This is where `iss` support is implemented.

**Files:**
- Create: `packages/server/src/mcp/oauth-metadata.ts` (AS metadata + PRM builders, `authorization_response_iss_parameter_supported: true`)
- Create: `packages/server/src/mcp/oauth-authorize-handler.ts` (authorization-code handler echoing `iss` on success + error redirects)
- Create: `packages/server/src/mcp/oauth-token-handler.ts` (`/token`, PKCE + `resource` echoing, refresh)
- Create: `packages/server/src/mcp/oauth-register.ts` (`/register`, DCR), `oauth-revoke.ts` (`/revoke`)
- Modify: `packages/server/src/mcp/oauth-route.ts` (wire the new handlers; remove `mcpAuthRouter`/`createOAuthMetadata` imports)
- Modify: `packages/server/src/mcp/oauth-provider.ts` (`AuthorizationParams` is now Dofek-defined; provider ignores `iss` — the handler injects it)

- [ ] **Step 1: Write the AS metadata test**

In `oauth-route.test.ts`, add a test asserting the AS metadata now includes:
```ts
expect(metadata.authorization_response_iss_parameter_supported).toBe(true);
expect(metadata.issuer).toBe("https://app.example.test/");
```

- [ ] **Step 2: Implement `oauth-metadata.ts`**

Replicate `createOAuthMetadata`'s output (fields already returned by the live Dofek endpoint: `issuer`, `authorization_endpoint`, `response_types_supported: ["code"]`, `code_challenge_methods_supported: ["S256"]`, `token_endpoint`, `token_endpoint_auth_methods_supported: ["client_secret_post","none"]`, `grant_types_supported`, `scopes_supported`, `revocation_endpoint`, `revocation_endpoint_auth_methods_supported`, `registration_endpoint`, `client_id_metadata_document_supported: true`) **plus** `authorization_response_iss_parameter_supported: true`. Include `buildProtectedResourceMetadata` returning `resource`, `authorization_servers`, `scopes_supported`, `resource_name`. The PRM URL helper stays `getOAuthProtectedResourceMetadataUrl` (now from `@modelcontextprotocol/server`).

- [ ] **Step 3: Implement `oauth-authorize-handler.ts`**

Port the v1 `authorizationHandler` phase-1/phase-2 validation (client_id, `redirectUriMatches`, response_type/code_challenge/S256/scope/state/resource) into Dofek code. On phase-2 success call `provider.authorize`; append `iss=<issuer>` to the success redirect and, on any `OAuthError`, to the error redirect via a local `errorRedirect(redirectUri, error, state)` that sets `iss`. Reuse `redirectUriMatches` from `@modelcontextprotocol/server` and `OAuthError` subclasses now defined/imported from `@modelcontextprotocol/core`/`server`.

- [ ] **Step 4: Implement `oauth-token-handler.ts`, `oauth-register.ts`, `oauth-revoke.ts`**

Port the v1 token/register/revoke handlers, keeping identical behavior (public-client `none`, `client_secret_post`, PKCE `verifyChallenge`, refresh rotation, DCR `client_id`+secret generation, revocation). Keep the `resource` echo requirement and the existing `parseScopes`/scope rules from `oauth-provider.ts`.

- [ ] **Step 5: Wire in `oauth-route.ts`**

Remove `mcpAuthRouter`/`createOAuthMetadata` imports; mount the new AS handlers at `/authorize`, `/token`, `/register`, `/revoke`, and the metadata routes. Remove the now-orphaned rate-limit plumbing that referenced SDK `authorizationOptions`/`tokenOptions` unless re-applied to the new handlers.

- [ ] **Step 6: Run the oauth + provider unit tests**

Run: `cd packages/server && pnpm vitest run --project unit src/mcp/oauth-router.test.ts src/mcp/oauth-route.test.ts src/mcp/oauth-provider.test.ts src/mcp/oauth.integration.test.ts`

Expected: pass (integration requires `pnpm test:integration` with Docker; run unit tier here, note integration not-run-locally).

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/mcp/
git commit -m "feat(mcp): reimplement OAuth AS in Dofek code with RFC 9207 iss support"
```

---

## Task 3: Adopt v2 `McpServer` + `registerTool` for tools

**Files:**
- Modify: `packages/server/src/mcp/tools.ts` (construct the v2 `McpServer`/`McpServerFactory`)
- Modify: every `*-tool.ts` / helper that types `McpServer` (26 files) — repoint the `McpServer` type import to `@modelcontextprotocol/server`
- Modify: `packages/server/src/mcp/app-resource.ts` (repoint `McpServer` import)
- Modify: `packages/server/src/mcp/request-telemetry.ts` (`SUPPORTED_PROTOCOL_VERSIONS` from `@modelcontextprotocol/server`)

- [ ] **Step 1: Learn the v2 registration signature**

Read `node_modules/@modelcontextprotocol/server/dist/index.d.mts` for `McpServer.registerTool` and `ToolCallback`. Record the exact `inputSchema`/`outputSchema`/`annotations`/`_meta` shape (schema fields are now Zod/Standard-Schema based).

- [ ] **Step 2: Rewrite `tools.ts` `createDofekMcpServer`**

Use the v2 `McpServer`/`McpServerFactory`. Re-register every tool preserving name/description/input/output schemas/annotations exactly (ChatGPT submission contract). Re-export the v2 `McpServer` type so the 26 tool files type-check.

- [ ] **Step 3: Repoint the 26 `McpServer` type-import sites**

Run: `rg -ln "server/mcp\.js|McpServer" packages/server/src/mcp --glob '*.ts' | grep -v test` and change `import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"` → `import type { McpServer } from "@modelcontextprotocol/server"` in each. In `app-resource.ts`, keep `registerAppResource`/`RESOURCE_MIME_TYPE` from `@modelcontextprotocol/ext-apps/server` (2.x).

- [ ] **Step 4: Typecheck**

Run: `cd packages/server && pnpm tsc --noEmit`. Iterate on any `registerTool`/`registerResource`/`ToolCallback` signature mismatches.

- [ ] **Step 5: Run the mcp unit suite**

Run: `cd packages/server && pnpm vitest run --project unit src/mcp/`

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/mcp/
git commit -m "refactor(mcp): adopt v2 McpServer and tool registration"
```

---

## Task 4: Adopt v2 streamable-HTTP transport + resource-server auth

**Files:**
- Modify: `packages/server/src/mcp/route.ts`

- [ ] **Step 1: Repoint the transport**

Replace `import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"` with the v2 Node transport from `@modelcontextprotocol/node` (`StreamableHTTPServerTransport` / `NodeStreamableHTTPServerTransport` wrapping `WebStandardStreamableHTTPServerTransport`).

- [ ] **Step 2: Replace bearer auth with v2 resource-server helpers**

Replace the hand-rolled `requireBearerTokenHeader` + `validateMcpToken` flow in `route.ts` with `verifyBearerToken`/`requireBearerAuth` from `@modelcontextprotocol/server` (mapping `AuthInfo` → the existing `createDofekMcpServer({ userId, clientId, scopes, ... })`). Keep the existing `401` + `WWW-Authenticate` challenge and `request-telemetry`/`mcp.tools_list` instrumentation.

- [ ] **Step 3: Replace PRM / metadata URL helper**

Use `getOAuthProtectedResourceMetadataUrl` from `@modelcontextprotocol/server` (same signature) so the `WWW-Authenticate: Bearer resource_metadata=...` header stays correct.

- [ ] **Step 4: Run route tests**

Run: `cd packages/server && pnpm vitest run --project unit src/mcp/route.test.ts src/mcp/route-lifecycle.test.ts`

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/mcp/route.ts
git commit -m "refactor(mcp): adopt v2 streamable-HTTP transport and resource-server auth"
```

---

## Task 5: Remove v1 sdk remnants, full validation, docs

**Files:**
- Modify: `packages/server/package.json` (confirm `@modelcontextprotocol/sdk` absent)
- Modify: `docs/mcp.md` (authorization flow: AS now emits `iss`; v2 SDK; note Apps UI via ext-apps 2.x)
- Modify: `docs/production-incident-baseline.md` (append the connect-failure incident)

- [ ] **Step 1: Confirm zero v1 imports**

Run: `rg -n "@modelcontextprotocol/sdk" packages/server/src --glob '*.ts' | grep -v '\.test\.ts'` → empty.

- [ ] **Step 2: Full pre-push checks**

Run: `pnpm lint`, `pnpm test:unit`, `pnpm tsc --noEmit`, `cd packages/server && pnpm tsc --noEmit`. Also `pnpm test:integration` locally if Docker is available (else note not-run).

- [ ] **Step 3: End-to-end verify**

Use MCP Inspector per `docs/mcp.md` "Manual Verification". Confirm `/.well-known/oauth-authorization-server` returns `authorization_response_iss_parameter_supported: true`, and `/authorize` redirects (success and error) carry `iss=https://dofek.fit/`.

- [ ] **Step 4: Document and commit**

```bash
git add packages/server/package.json docs/mcp.md docs/production-incident-baseline.md
git commit -m "docs(mcp): document v2 SDK migration and issuer identification"
```

---

## Self-review notes

- **Biggest risk = Tasks 3 + 4** (v2 `McpServer`/`registerTool` and transport are rewrites). Verify against installed `.d.mts`; do not assume signatures.
- **`iss` fix lands in Task 2** (AS owns `authorization_response_iss_parameter_supported` + redirect `iss`). Do not advertise the flag before redirect echo is in place (ChatGPT rejects mismatch).
- **`ext-apps` 2.x** peers on `@modelcontextprotocol/{core,client,server}`; confirm the 2.x `registerAppResource` signature unchanged before relying on it in `app-resource.ts`.
- **No `server-legacy`** anywhere in the final dependency graph.