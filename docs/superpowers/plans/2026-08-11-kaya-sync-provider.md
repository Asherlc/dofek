# Kaya Sync Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-user credential-based Kaya API sync provider that imports Kaya sessions and ascents, including route lead/top-rope data, without changing the existing `kaya-export` importer.

**Architecture:** `@dofek/kaya-client` isolates all reverse-engineered Kaya REST and GraphQL behavior behind Zod-validated typed methods. `KayaSyncProvider` loads each user's stored token and maps returned sessions/ascents to canonical activities and climbing entries. A nullable canonical `lead` boolean stores the route-level Kaya value; boulders retain `null`.

**Tech Stack:** TypeScript, Zod, Drizzle ORM, PostgreSQL, Vitest, OpenAPI 3.1, shared provider metadata.

## Global Constraints

- Keep `kaya` and `kaya-export` as distinct provider IDs; do not change CSV importer behavior.
- Authenticate only with per-user credentials through `automatedLogin`; do not add application environment secrets.
- Validate every Kaya HTTP/GraphQL response with Zod at the client boundary.
- Use stable Kaya IDs for activities and climbing entries; preserve the vendor response in the existing raw columns.
- Use `lead` only when `climb_type` is a route; store `null` for boulders and never infer rope style from grade or send status.
- Reconcile activity absence only after a complete authoritative activity-list response.
- Write each test first, run it red, then implement the minimum production code to pass it.

---

### Task 1: Persist Kaya's route-level lead value

**Files:**
- Modify: `src/db/schema/activity.ts`
- Create: `drizzle/0074_climbing_entry_lead.sql`
- Modify: `src/providers/kaya/import.ts`
- Modify: `src/providers/kaya/import.test.ts`
- Test: `src/providers/kaya/import.integration.test.ts`

**Interfaces:**
- Produces: `climbingEntry.lead: boolean | null`; `null` means non-route or unavailable.
- Consumes: Kaya's raw `climb.lead` boolean and existing `climbingEntry` insert shape.

- [ ] **Step 1: Write the failing importer and database tests**

Add a route fixture to `src/providers/kaya/import.test.ts` that proves legacy CSV rows still insert `lead: null`. Add an integration test that inserts a route entry with `lead: true`, reloads it through Postgres, and expects `true`; insert a boulder with `lead: null` and expect `null`.

```ts
expect(activity.entries).toEqual([
  expect.objectContaining({ climbType: "route", lead: null }),
]);
expect(storedRoute.lead).toBe(true);
expect(storedBoulder.lead).toBeNull();
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `rtk pnpm vitest run src/providers/kaya/import.test.ts src/providers/kaya/import.integration.test.ts`

Expected: the TypeScript test compile or assertion fails because `lead` is absent from `KayaClimbingEntry` and `fitness.climbing_entry`.

- [ ] **Step 3: Add the nullable schema column and forward migration**

Add `lead: boolean("lead")` to `climbingEntry`; create `drizzle/0074_climbing_entry_lead.sql` containing only:

```sql
ALTER TABLE fitness.climbing_entry
ADD COLUMN lead boolean;

ALTER TABLE fitness.climbing_entry
ADD CONSTRAINT climbing_entry_lead_routes_only CHECK (
  lead IS NULL OR climb_type = 'route'
);
```

Set `lead: null` in the importer’s `KayaClimbingEntry` mapping and insert.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `rtk pnpm test:integration -- src/providers/kaya/import.integration.test.ts && rtk pnpm vitest run src/providers/kaya/import.test.ts`

Expected: both tests pass against the migrated database; no CSV row gains a fabricated rope style.

- [ ] **Step 5: Commit**

```bash
rtk git add src/db/schema/activity.ts drizzle/0074_climbing_entry_lead.sql src/providers/kaya/import.ts src/providers/kaya/import.test.ts src/providers/kaya/import.integration.test.ts
rtk git commit -m "feat: store climbing route lead style"
```

### Task 2: Create the isolated Kaya API client

**Files:**
- Create: `packages/kaya-client/package.json`
- Create: `packages/kaya-client/tsconfig.json`
- Create: `packages/kaya-client/README.md`
- Create: `packages/kaya-client/AGENTS.md`
- Create: `packages/kaya-client/src/types.ts`
- Create: `packages/kaya-client/src/client.ts`
- Create: `packages/kaya-client/src/client.test.ts`
- Modify: `pnpm-workspace.yaml`
- Modify: `package.json`

**Interfaces:**
- Produces: `KayaClient`, `signInToKaya`, `KayaInvalidCredentialsError`, `KayaApiError`, `KayaSession`, and `KayaAscent` from `@dofek/kaya-client`.
- Consumes: a `fetch` implementation and the app-observed `POST /api/user/login` and `/graphql` endpoints.

- [ ] **Step 1: Write failing client tests**

Write `client.test.ts` with a mocked fetch that verifies all of the following concrete behavior:

```ts
await expect(signInToKaya("climber@example.com", "password", fetchFn)).resolves.toEqual({
  accessToken: "kaya-token",
  userId: "42",
});
expect(loginRequest).toMatchObject({
  method: "POST",
  headers: { "content-type": "application/json", origin: "https://kaya-app.kayaclimb.com" },
  body: JSON.stringify({ email: "climber@example.com", password: "password" }),
});
await expect(client.listSessions({ userId: "42", since })).resolves.toEqual([expectedSession]);
await expect(client.listAscents({ userId: "42", since })).resolves.toEqual([expectedAscent]);
expect(graphqlRequest.headers).toMatchObject({ authorization: "Bearer kaya-token" });
expect(expectedAscent.climb.lead).toBe(true);
```

Include separate failures for HTTP 401, a GraphQL `errors` response, and a response where `climb.lead` is a string. The assertion that must fail if production behavior regresses is: changing the GraphQL selection from `lead` to any other field makes the lead-mapping test fail.

- [ ] **Step 2: Run the client tests to verify they fail**

Run: `rtk pnpm vitest run packages/kaya-client/src/client.test.ts`

Expected: FAIL because the package and exported client methods do not exist.

- [ ] **Step 3: Implement the client boundary**

Create Zod schemas for the exact login, current-user, session, and ascent response shapes captured from Kaya. Implement:

```ts
export async function signInToKaya(
  email: string,
  password: string,
  fetchFn: typeof fetch,
): Promise<{ accessToken: string; userId: string }>;

export class KayaClient {
  constructor(accessToken: string, fetchFn?: typeof fetch);
  currentUser(): Promise<{ id: string }>;
  listSessions(input: { userId: string; since: Date }): Promise<KayaSession[]>;
  listAscents(input: { userId: string; since: Date }): Promise<KayaAscent[]>;
}
```

The GraphQL ascent selection must include `climb { id name lead climb_type { name } grade { name climb_type_group } gym { name } }`, and each response must be parsed before it crosses the package boundary. Throw `KayaInvalidCredentialsError` only for the confirmed rejected-login response; all other HTTP and GraphQL failures must retain status/message in `KayaApiError`.

Add the workspace package and root package exports needed by the provider. Add `README.md` documenting that the contract is reverse-engineered from Kaya’s application and add `AGENTS.md` with `CLAUDE.md` and `GEMINI.md` symlinked to it.

- [ ] **Step 4: Run the client test and package checks**

Run: `rtk pnpm vitest run packages/kaya-client/src/client.test.ts && rtk pnpm typecheck --filter @dofek/kaya-client`

Expected: client tests and package typecheck pass.

- [ ] **Step 5: Commit**

```bash
rtk git add packages/kaya-client pnpm-workspace.yaml package.json
rtk git commit -m "feat: add Kaya API client"
```

### Task 3: Implement the credential sync provider

**Files:**
- Create: `src/providers/kaya-sync.ts`
- Create: `src/providers/kaya-sync.test.ts`
- Create: `src/providers/kaya-sync.integration.test.ts`
- Modify: `src/providers/provider-auth-policy.test.ts`

**Interfaces:**
- Consumes: `KayaClient`, `signInToKaya`, `climbingEntry.lead`, `SyncRun`, `loadTokens`, and `ProviderActivityListSync`.
- Produces: `KayaSyncProvider implements SyncProvider` with `id === "kaya"`, `authSetup().automatedLogin`, and a sync result counted by inserted ascents.

- [ ] **Step 1: Write failing provider tests**

Create a unit test that injects a client fetch fixture and asserts credential login produces a token set with a serialized Kaya user ID. Add a sync test with one boulder and one route ascent:

```ts
expect(insertedEntries).toEqual([
  expect.objectContaining({ externalId: "ascent-boulder", climbType: "boulder", lead: null }),
  expect.objectContaining({ externalId: "ascent-route", climbType: "route", lead: true }),
]);
expect(result).toMatchObject({ provider: "kaya", recordsSynced: 2, errors: [] });
```

Add an integration test that runs against Postgres, syncs the same session twice with a changed ascent payload, and confirms stable activity/ascent IDs, authoritative replacement, and reconciliation only after a complete list.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `rtk pnpm vitest run src/providers/kaya-sync.test.ts && rtk pnpm test:integration -- src/providers/kaya-sync.integration.test.ts`

Expected: FAIL because `KayaSyncProvider` does not exist and `kaya` is not registered.

- [ ] **Step 3: Implement token lifecycle and sync mapping**

Implement a `KayaSyncProvider` that:

```ts
readonly id = "kaya";
readonly name = "Kaya";
readonly scheduledSyncLookbackDays = 30;
```

Its `authSetup()` calls `signInToKaya`, converts invalid credentials to `ProviderInvalidCredentialsError`, and stores `JSON.stringify({ kayaUserId })` in `TokenSet.scopes`. Its `sync(run)` loads tokens, parses `kayaUserId`, calls session/ascent methods for `run.window.since`, upserts one `rock_climbing` activity per Kaya session, deletes/reinserts that session’s authoritative climbing entries, and sets:

```ts
lead: ascent.climb.type === "route" ? ascent.climb.lead : null
```

Use the shared `ProviderActivityListSync`/`upsertProviderActivity` APIs. Missing credentials must return `ProviderStoredIdentityMissingError`; unexpected errors must call `captureException` and add a per-record `SyncError` without reconciling a partial list.

- [ ] **Step 4: Run provider tests and auth policy**

Run: `rtk pnpm vitest run src/providers/kaya-sync.test.ts src/providers/provider-auth-policy.test.ts && rtk pnpm test:integration -- src/providers/kaya-sync.integration.test.ts`

Expected: provider unit, auth-policy, and database integration tests pass.

- [ ] **Step 5: Commit**

```bash
rtk git add src/providers/kaya-sync.ts src/providers/kaya-sync.test.ts src/providers/kaya-sync.integration.test.ts src/providers/provider-auth-policy.test.ts
rtk git commit -m "feat: sync Kaya climbing sessions"
```

### Task 4: Register Kaya in both server paths and shared metadata

**Files:**
- Modify: `src/jobs/provider-registration.ts`
- Modify: `packages/server/src/routers/sync-helpers.ts`
- Modify: `src/jobs/provider-queue-config.ts`
- Modify: `packages/providers-meta/src/providers.ts`
- Modify: `packages/providers-meta/src/providers.test.ts`
- Modify: `package.json`
- Modify: `src/providers/README.md`
- Modify: `src/providers/AGENTS.md`

**Interfaces:**
- Consumes: `KayaSyncProvider` at root export `dofek/providers/kaya-sync`.
- Produces: a visible, credential-authenticated `kaya` provider card on both clients while preserving the `kaya-export` import card.

- [ ] **Step 1: Write failing registration and metadata tests**

Extend the existing registry test to expect both Kaya IDs independently, then add metadata expectations:

```ts
expect(mockRegisterProvider).toHaveBeenCalledWith(expect.objectContaining({ id: "kaya" }));
expect(mockRegisterProvider).toHaveBeenCalledWith(expect.objectContaining({ id: "kaya-export" }));
expect(PROVIDER_LABELS.kaya).toBe("Kaya");
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `rtk pnpm vitest run packages/server/src/routers/sync-registration.test.ts packages/providers-meta/src/providers.test.ts`

Expected: FAIL because only `kaya-export` is registered and labeled through import UI paths.

- [ ] **Step 3: Register and document the provider**

Add lazy `kaya` registration before the existing `kaya-export` registration in both worker/server lists. Add a frequent, single-concurrency queue configuration due to the undocumented API. Add the `kaya` provider label and stable brand-color fallback. Export the provider from the root package map. Update provider docs to state that Kaya credential sync and CSV import are separate sources and that `lead` is API-confirmed route metadata.

- [ ] **Step 4: Run registration, metadata, and type checks**

Run: `rtk pnpm vitest run packages/server/src/routers/sync-registration.test.ts packages/providers-meta/src/providers.test.ts && rtk pnpm typecheck`

Expected: registrations remain symmetrical, `kaya-export` remains available, and all packages typecheck.

- [ ] **Step 5: Commit**

```bash
rtk git add src/jobs/provider-registration.ts packages/server/src/routers/sync-helpers.ts src/jobs/provider-queue-config.ts packages/providers-meta/src/providers.ts packages/providers-meta/src/providers.test.ts package.json src/providers/README.md src/providers/AGENTS.md
rtk git commit -m "feat: register Kaya credential provider"
```

### Task 5: Publish the reverse-engineered API contract

**Files:**
- Create: `docs/kaya-api.openapi.yaml`
- Create: `docs/kaya.md`
- Modify: `package.json`

**Interfaces:**
- Produces: a valid OpenAPI 3.1 description of `POST /api/user/login` and `POST /graphql`, including named current-user/session/ascent operations and the nested `climb.lead` field.

- [ ] **Step 1: Write the OpenAPI validation command before adding the document**

Extend the existing `lint:openapi` script so it validates both contracts:

```json
"lint:openapi": "redocly lint docs/whoop-api.openapi.yaml docs/kaya-api.openapi.yaml --extends minimal"
```

Run: `rtk pnpm lint:openapi`

Expected: FAIL because `docs/kaya-api.openapi.yaml` does not exist.

- [ ] **Step 2: Add the documented observed contract**

Create a 3.1 document whose server is `https://kaya-beta.kayaclimb.com`, whose bearer scheme applies to `/graphql`, and whose login operation accepts `{ email, password }`. Model GraphQL as a POST envelope with operation-specific examples for `currentUser`, `sessionsForUser`, and `ascentsForUser`; the ascent example must include:

```yaml
climb:
  climb_type:
    name: Routes
  lead: true
```

State in `docs/kaya.md` that this is an observed, reverse-engineered contract, include the Kaya app URL as its primary source, list the authentication and sync behavior, and document the non-inference rule for rope style.

- [ ] **Step 3: Run contract lint and documentation checks**

Run: `rtk pnpm lint:openapi && rtk git diff --check`

Expected: both OpenAPI documents pass Redocly minimal validation and the documentation diff has no whitespace errors.

- [ ] **Step 4: Commit**

```bash
rtk git add docs/kaya-api.openapi.yaml docs/kaya.md package.json
rtk git commit -m "docs: document Kaya API contract"
```

### Task 6: Verify the full provider change

**Files:**
- Modify: `docs/superpowers/plans/2026-08-11-kaya-sync-provider.md` (mark completed steps only)

- [ ] **Step 1: Run focused checks**

Run: `rtk pnpm vitest run packages/kaya-client/src/client.test.ts src/providers/kaya/import.test.ts src/providers/kaya-sync.test.ts src/providers/provider-auth-policy.test.ts packages/server/src/routers/sync-registration.test.ts packages/providers-meta/src/providers.test.ts`

Expected: all focused unit tests pass.

- [ ] **Step 2: Run database and repository checks**

Run: `rtk pnpm test:integration -- src/providers/kaya/import.integration.test.ts src/providers/kaya-sync.integration.test.ts && rtk pnpm lint && rtk pnpm typecheck && rtk pnpm lint:openapi`

Expected: integration tests, lint, typecheck, and OpenAPI validation pass without retries or warning-based continuation.

- [ ] **Step 3: Inspect final scope and commit plan state**

Run: `rtk git status --short && rtk git diff --check HEAD~1..HEAD`

Expected: only intended Kaya, climbing-entry, provider registry, and documentation files are changed; the pre-existing untracked `paseo.json` remains unmodified.

- [ ] **Step 4: Commit and push the completed plan record**

```bash
rtk git add docs/superpowers/plans/2026-08-11-kaya-sync-provider.md
rtk git commit -m "docs: record Kaya provider verification"
rtk git push
```
