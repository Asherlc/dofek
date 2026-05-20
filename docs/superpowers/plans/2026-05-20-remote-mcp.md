# Remote MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a per-user authenticated remote MCP endpoint inside the existing Dofek Express server.

**Architecture:** Add `@modelcontextprotocol/sdk` and mount a Streamable HTTP MCP route at `/api/mcp`. Store dedicated hashed MCP bearer tokens in Postgres, expose tRPC token management for authenticated users, and implement five narrow tools using existing repositories and queues.

**Tech Stack:** TypeScript, Express 5, tRPC, Drizzle SQL migrations, Zod, BullMQ, `@modelcontextprotocol/sdk`.

---

## File Structure

- Create `drizzle/0024_mcp_access_token.sql`: Postgres table for MCP tokens.
- Modify `src/db/schema.ts`: Drizzle table definition.
- Create `packages/server/src/mcp/token-repository.ts`: token generation, hashing, validation, revocation, scope checks.
- Create `packages/server/src/mcp/token-repository.test.ts`: unit tests for token behavior.
- Create `packages/server/src/mcp/tools.ts`: MCP tool registration and tool implementation helpers.
- Create `packages/server/src/mcp/route.ts`: Express request handler for authenticated Streamable HTTP.
- Create `packages/server/src/mcp/route.test.ts`: route/auth/protocol tests.
- Create `packages/server/src/routers/mcp.ts`: authenticated token management tRPC procedures.
- Create `packages/server/src/routers/mcp.test.ts`: tRPC token management tests.
- Modify `packages/server/src/router.ts`: mount `mcp` tRPC router.
- Modify `packages/server/src/index.ts`: mount `/api/mcp`.
- Modify `packages/server/package.json` and `pnpm-lock.yaml`: add `@modelcontextprotocol/sdk`.
- Create `docs/mcp.md`: user-facing setup and tool documentation.
- Modify `docs/README.md`: link MCP docs.

## Task 1: Token Storage and Repository

- [ ] Add `@modelcontextprotocol/sdk@1.29.0` to `dofek-server`.
- [ ] Write `packages/server/src/mcp/token-repository.test.ts` first with tests for:
  - generated token starts with `dofek_mcp_`;
  - created token stores only a hash;
  - valid token loads `userId` and scopes;
  - revoked token validates as null;
  - expired token validates as null;
  - `requireMcpScope(["health:read"], "health:read")` passes;
  - `requireMcpScope(["health:read"], "sync:write")` throws an insufficient-scope error.
- [ ] Run:

```bash
CLICKHOUSE_URL=http://default:health@localhost:8123 pnpm vitest run packages/server/src/mcp/token-repository.test.ts
```

Expected: fails because the module does not exist.

- [ ] Add `drizzle/0024_mcp_access_token.sql`.
- [ ] Add `mcpAccessToken` to `src/db/schema.ts`.
- [ ] Implement `packages/server/src/mcp/token-repository.ts` with `generateMcpToken`, `hashMcpToken`, `createMcpToken`, `validateMcpToken`, `revokeMcpToken`, `listMcpTokens`, `requireMcpScope`, and `McpAuthError`.
- [ ] Rerun the token repository test until it passes.
- [ ] Commit:

```bash
git add drizzle/0024_mcp_access_token.sql src/db/schema.ts packages/server/src/mcp/token-repository.ts packages/server/src/mcp/token-repository.test.ts packages/server/package.json pnpm-lock.yaml
git commit -m "feat: add mcp token storage"
git push
```

## Task 2: Token Management tRPC Router

- [ ] Write `packages/server/src/routers/mcp.test.ts` first with tests for:
  - unauthenticated callers cannot create tokens;
  - authenticated callers can create a token and receive the raw token once;
  - list returns token metadata without the raw token or hash;
  - revoke removes future access by setting `revokedAt`.
- [ ] Run:

```bash
CLICKHOUSE_URL=http://default:health@localhost:8123 pnpm vitest run packages/server/src/routers/mcp.test.ts
```

Expected: fails because the router does not exist.

- [ ] Implement `packages/server/src/routers/mcp.ts` using protected procedures and Zod input schemas.
- [ ] Mount it in `packages/server/src/router.ts`.
- [ ] Rerun the router test until it passes.
- [ ] Commit:

```bash
git add packages/server/src/routers/mcp.ts packages/server/src/routers/mcp.test.ts packages/server/src/router.ts
git commit -m "feat: add mcp token management api"
git push
```

## Task 3: MCP Route and Tool Registry

- [ ] Write `packages/server/src/mcp/route.test.ts` first with tests for:
  - missing `Authorization` returns `401` and `WWW-Authenticate: Bearer`;
  - invalid bearer token returns `401`;
  - valid token can initialize MCP and list tools;
  - token lacking a required scope gets a tool-level insufficient-scope failure.
- [ ] Run:

```bash
CLICKHOUSE_URL=http://default:health@localhost:8123 pnpm vitest run packages/server/src/mcp/route.test.ts
```

Expected: fails because the route does not exist.

- [ ] Implement `packages/server/src/mcp/tools.ts` with tool registration for:
  - `get_daily_health_summary`
  - `search_activities`
  - `log_food`
  - `list_providers`
  - `start_provider_sync`
- [ ] Implement `packages/server/src/mcp/route.ts` using `@modelcontextprotocol/sdk` Streamable HTTP transport and per-request bearer validation.
- [ ] Mount `/api/mcp` in `packages/server/src/index.ts` before SPA fallback.
- [ ] Rerun the route test until it passes.
- [ ] Commit:

```bash
git add packages/server/src/mcp/tools.ts packages/server/src/mcp/route.ts packages/server/src/mcp/route.test.ts packages/server/src/index.ts
git commit -m "feat: expose remote mcp route"
git push
```

## Task 4: Docs and Final Verification

- [ ] Create `docs/mcp.md` with:
  - token creation and revocation;
  - `/api/mcp` URL;
  - bearer-token client configuration;
  - `mcp-remote` example;
  - inspector verification command;
  - scopes and tools.
- [ ] Link it from `docs/README.md`.
- [ ] Run:

```bash
pnpm lint
CLICKHOUSE_URL=http://default:health@localhost:8123 pnpm test:changed
pnpm tsc --noEmit
cd packages/server && pnpm tsc --noEmit
cd packages/web && pnpm tsc --noEmit
```

- [ ] Commit:

```bash
git add docs/mcp.md docs/README.md
git commit -m "docs: document remote mcp setup"
git push
```

## Self-Review

- Spec coverage: token auth, official SDK, Express route, all five tools, docs, and tests are covered.
- Placeholder scan: no task contains TBD/TODO/fill-in placeholders.
- Type consistency: token scopes, route path, and tool names match the design spec.
