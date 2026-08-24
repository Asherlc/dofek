# Self-Service Developer Clients Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an authenticated Dofek user create and manage an owner-scoped external developer client from web or mobile while preserving the existing PKCE-bound nutrition-write API and requiring an exact registered HTTPS redirect URI.

**Architecture:** Add canonical developer-client contracts to the existing shared authentication package, model the complete external-client schema in Drizzle, and put all owner-scoped persistence and audit behavior in one server repository. Mount a session-authenticated REST management router at /api/developer/clients, keep integration credentials and grants on /api/external/v1, and have both first-party clients use the same typed REST client without caching raw secrets. Add the support-only administrator view through the existing admin tRPC and web surfaces; keep the separately deployed Slack Worker outside this repository.

**Tech Stack:** TypeScript, Zod, Express, express-rate-limit, Drizzle ORM, PostgreSQL/TimescaleDB, Vitest, React, TanStack Router and Query, React Native, Expo Router, Expo Clipboard, Storybook, OpenAPI.

**Spec:** [docs/superpowers/specs/2026-08-24-self-service-developer-clients-design.md](../specs/2026-08-24-self-service-developer-clients-design.md)

## Global Constraints

- Self-service creation is authenticated and owner-scoped; this is not RFC 7591 Dynamic Client Registration.
- The only first-release scope is exactly nutrition:write. Any scope expansion requires a separate product and security review.
- Every registered redirect is a complete HTTPS URI with no credentials or fragment. Link start accepts only a byte-for-byte match with a stored canonical URI.
- Preserve Bearer clientId.clientSecret client authentication, S256 PKCE, the existing consent screen, one-time short-lived codes, and fifteen-minute opaque bearer grants.
- Store only SHA-256 secret hashes. Return a raw secret only in the successful create or rotate response, and never persist, cache, log, or report it.
- Owner-scoped missing and non-owned resources are indistinguishable 404 responses.
- Revocation atomically revokes the client and every active grant.
- Create, update, rotate, and revoke append audit events containing only actor, client, action, and timestamp.
- Never log raw secrets, authorization codes, access tokens, Slack identifiers, or Dofek user identifiers.
- Implement the same developer-client capabilities on web and mobile. Clients render server data and surface the server's safe error message.
- Keep route tests outside packages/mobile/app; use packages/mobile/app-tests and packages/mobile/app-stories.
- Do not add a second management API through tRPC. The canonical owner API is /api/developer/clients.
- Do not restore Slack-specific storage or bot code in Dofek. Core food storage remains provider-agnostic.
- No production secret configuration or deployment is part of executing Tasks 1–11. The rollout handoff at the end requires separate authorization.
- Before every push, run pnpm lint, the task's focused tests, pnpm tsc --noEmit, pnpm --dir=packages/server tsc --noEmit, and pnpm --dir=packages/web tsc --noEmit; also run pnpm --dir=packages/mobile typecheck when mobile files changed.

---

## Decisions Required Before Execution

The approved design leaves five implementation-significant choices open. This plan is written to the recommended resolutions below so its interfaces remain exact. Before Task 1, confirm the resolutions or revise this plan; do not silently choose different behavior during implementation.

1. **Revoked owner reads:** Return revoked clients from GET / and GET /:clientId so the promised revoked status and detail screen are possible. Continue returning 404 for every mutation against a revoked client and for every missing or non-owned client. This resolves the design's conflict between displaying revoked detail and saying every revoked lookup is 404.
2. **Legacy clients:** Treat every currently provisioned client as unaccountable unless a production inventory explicitly identifies an owner before migration review. Migration 0096 revokes every ownerless legacy client and enforces that an ownerless client cannot remain active. Do not put production user IDs in this plan, logs, or test fixtures.
3. **Rate limits:** Use five create attempts per user-facing IP per hour, five rotate attempts per user-facing IP per hour, and sixty link-start attempts per client-facing IP per fifteen minutes. Count successful and rejected requests, return the existing structured 429 problem, and retain the existing rejected-request limiter for other external API operations.
4. **Settings placement:** Add “Developer integrations” as a destination in the existing Advanced settings category on both clients, with dedicated list and detail routes instead of expanding the already-large settings components.
5. **Slack boundary:** The Slack Food Bot Worker source is not in this repository; commit ca467450 intentionally removed the in-process Slack bot. Finish the Dofek platform in this plan, then prepare a separate plan in the Worker repository after its repository URL and local instructions are supplied.

## File Structure

### Shared contract

- Modify packages/auth/package.json: export the developer-client module.
- Create packages/auth/src/developer-clients.ts: scopes, request/response schemas, canonical HTTPS redirect parsing, safe problem parsing, and the transport-neutral REST client.
- Create packages/auth/src/developer-clients.test.ts: contract, redirect, response, and error behavior.
- Modify packages/auth/README.md: document the production consumers and one-time-secret boundary.

### Schema and persistence

- Create src/db/schema/external.ts: Drizzle definitions for the existing external API tables plus owner, redirect, audit, and rotation fields.
- Modify src/db/drizzle-schema.ts: include the external schema.
- Create drizzle/0096_self_service_developer_clients.sql: add ownership, redirects, audit, last rotation, constraints, indexes, legacy revocation, and account-erasure ownership behavior.
- Modify drizzle/meta/_journal.json: register migration 0096.
- Modify src/db/db.integration.test.ts: execute ownership, redirect, audit, and cascade constraints against PostgreSQL.
- Modify docs/schema.dbml and docs/schema.puml: regenerate diagrams from the Drizzle schema.
- Create packages/server/src/repositories/developer-client-repository.ts: owner/admin reads and atomic lifecycle writes.
- Create packages/server/src/repositories/developer-client-repository.integration.test.ts: real-Postgres lifecycle, isolation, audit, grant, redirect, and cascade coverage.

### Server routes

- Create packages/server/src/routes/api-problem.ts and api-problem.test.ts: shared structured problem response construction for external and developer REST routes.
- Modify packages/server/src/routes/external-write-api-primitives.ts and its test: retain only security primitives.
- Create packages/server/src/routes/developer-clients.ts: authenticated /api/developer/clients router and mutation rate limits.
- Create packages/server/src/routes/developer-clients.integration.test.ts: full HTTP management coverage against PostgreSQL.
- Modify packages/server/src/routes/external-write-api.ts: remove administrator provisioning, enforce registered redirects, and apply link-start rate limiting.
- Modify packages/server/src/routes/external-write-api.integration.test.ts: create an owner client through the new API and prove the full PKCE/write flow.
- Modify packages/server/src/index.ts and index tests: mount the developer router.

### Administrator support

- Modify packages/server/src/routers/admin.ts and admin.test.ts: list all clients without secrets and allow audited administrator revocation.
- Create packages/web/src/components/DeveloperClientsAdminPanel.tsx, its test, and its story: support-only client list and revoke confirmation.
- Modify packages/web/src/pages/AdminPage.tsx and its tests: add the Developer Clients tab without moving existing tabs.

### Web

- Create packages/web/src/lib/developer-clients.ts and its test: cookie-authenticated adapter around the shared REST client.
- Create packages/web/src/components/DeveloperClientSecretDialog.tsx, its test, and its story: one-time display and copy behavior.
- Create packages/web/src/components/DeveloperClientForm.tsx, its test, and its story: name, canonical redirect set, and fixed scope.
- Create packages/web/src/pages/DeveloperIntegrationsPage.tsx and its test: list, loading/error/empty states, and create flow.
- Create packages/web/src/pages/DeveloperClientDetailPage.tsx and its test: detail, edit, rotate, revoke, and targeted invalidation.
- Create packages/web/src/routes/developer-integrations/index.tsx and $clientId.tsx: dedicated settings routes.
- Modify packages/web/src/routeTree.gen.ts: generated route definitions.
- Modify packages/web/src/pages/SettingsPage.tsx, settingsCategories.ts, and settings tests: link from Advanced settings.

### Mobile

- Modify packages/mobile/package.json and pnpm-lock.yaml: add the Expo-compatible expo-clipboard release through Expo's installer.
- Create packages/mobile/lib/developer-clients.ts and its test: bearer-session adapter around the shared REST client.
- Create packages/mobile/components/DeveloperClientSecretPanel.tsx, its test, and its story.
- Create packages/mobile/components/DeveloperClientForm.tsx, its test, and its story.
- Create packages/mobile/app/developer-integrations/index.tsx and [clientId].tsx: list/create and detail/edit/rotate/revoke screens.
- Create packages/mobile/app-tests/developer-integrations-index.test.tsx and developer-integrations-detail.test.tsx.
- Create packages/mobile/app-stories/developer-integrations.stories.tsx.
- Modify packages/mobile/app/settings.tsx, settings tests, and settings stories: link from Advanced settings.

### Contracts and docs

- Modify packages/server/openapi/external-v1.yaml: remove administrator provisioning operations and require a registered redirect at link start.
- Modify docs/external-api.md: document developer ownership, exact registered HTTPS redirects, and Slack as a normal external client.

---

### Task 1: Shared Developer-Client Contract and REST Client

**Files:**
- Create: packages/auth/src/developer-clients.ts
- Create: packages/auth/src/developer-clients.test.ts
- Modify: packages/auth/package.json
- Modify: packages/auth/README.md

**Interfaces:**
- Produces: DEVELOPER_CLIENT_SCOPES, DeveloperClientInputSchema, DeveloperClientUpdateSchema, DeveloperClientSummarySchema, DeveloperClientDetailSchema, DeveloperClientSecretSchema, DeveloperApiProblemSchema, canonicalizeDeveloperRedirectUri(value), DeveloperClientsApiError, createDeveloperClientsApi(request).
- Consumes: Zod 4.4.3 already pinned by @dofek/auth.

- [ ] **Step 1: Write the failing contract tests**

Cover the exact behaviors below in developer-clients.test.ts:

~~~typescript
it.each([
  "http://client.example/callback",
  "https://user:password@client.example/callback",
  "https://client.example/callback#fragment",
  "not a uri",
])("rejects an unsafe redirect URI: %s", (redirectUri) => {
  expect(() => canonicalizeDeveloperRedirectUri(redirectUri)).toThrow();
});

it("canonicalizes registration values and rejects canonical duplicates", () => {
  expect(canonicalizeDeveloperRedirectUri("https://client.example")).toBe(
    "https://client.example/",
  );
  expect(
    DeveloperClientInputSchema.safeParse({
      name: "Meal importer",
      redirectUris: ["https://client.example", "https://client.example/"],
      scopes: ["nutrition:write"],
    }).success,
  ).toBe(false);
});

it("parses a safe problem and surfaces its server message", async () => {
  const api = createDeveloperClientsApi(async () =>
    new Response(
      JSON.stringify({
        type: "https://api.dofek.example/problems/not-found",
        title: "Not found",
        status: 404,
        code: "NOT_FOUND",
        message: "The requested integration was not found.",
        requestId: "request-1",
        details: [],
      }),
      { status: 404, headers: { "content-type": "application/json" } },
    ),
  );
  await expect(api.get("ext_missing")).rejects.toMatchObject({
    code: "NOT_FOUND",
    message: "The requested integration was not found.",
    status: 404,
  });
});
~~~

Also prove the list and detail schemas never accept clientSecret, create/rotate require it, the only accepted scope array is exactly ["nutrition:write"], names are trimmed and non-empty, redirect sets contain at least one canonical URI, and the API methods use these paths:

~~~text
GET    /api/developer/clients
POST   /api/developer/clients
GET    /api/developer/clients/:clientId
PATCH  /api/developer/clients/:clientId
POST   /api/developer/clients/:clientId/rotate
POST   /api/developer/clients/:clientId/revoke
~~~

- [ ] **Step 2: Run the tests and verify the red state**

Run:

~~~bash
rtk pnpm vitest run --project unit packages/auth/src/developer-clients.test.ts
~~~

Expected: FAIL because the module and package export do not exist.

- [ ] **Step 3: Implement the shared contract**

Use these exact public shapes:

~~~typescript
export type DeveloperClientScope = "nutrition:write";
export type DeveloperClientStatus = "active" | "revoked";

export interface DeveloperClientSummary {
  clientId: string;
  name: string;
  scopes: DeveloperClientScope[];
  status: DeveloperClientStatus;
  createdAt: string;
  lastRotatedAt: string;
}

export interface DeveloperClientDetail extends DeveloperClientSummary {
  redirectUris: string[];
}

export interface DeveloperClientSecret {
  client: DeveloperClientDetail;
  clientSecret: string;
}

export type DeveloperClientsRequest = (
  path: string,
  init: RequestInit,
) => Promise<Response>;

export interface DeveloperClientsApi {
  list(): Promise<DeveloperClientSummary[]>;
  create(input: DeveloperClientInput): Promise<DeveloperClientSecret>;
  get(clientId: string): Promise<DeveloperClientDetail>;
  update(clientId: string, input: DeveloperClientUpdate): Promise<DeveloperClientDetail>;
  rotate(clientId: string): Promise<DeveloperClientSecret>;
  revoke(clientId: string): Promise<{ revoked: true }>;
}
~~~

canonicalizeDeveloperRedirectUri must parse with URL, require protocol === "https:", reject username, password, and hash, and return URL.href. Registration/update schemas transform each value, then reject duplicates after transformation. The link-start task will require the incoming string to equal this canonical output before checking the database, preserving byte-for-byte matching.

createDeveloperClientsApi must JSON-encode bodies, parse every success with the matching Zod schema, parse non-2xx bodies with DeveloperApiProblemSchema, and throw DeveloperClientsApiError. It must never log request or response bodies.

Add the package export:

~~~json
"./developer-clients": "./src/developer-clients.ts"
~~~

- [ ] **Step 4: Run the tests and typecheck the package**

Run:

~~~bash
rtk pnpm vitest run --project unit packages/auth/src/developer-clients.test.ts
rtk pnpm --dir=packages/auth typecheck
~~~

Expected: PASS.

- [ ] **Step 5: Commit and push**

~~~bash
rtk git add packages/auth/package.json packages/auth/README.md packages/auth/src/developer-clients.ts packages/auth/src/developer-clients.test.ts
rtk git commit -m "feat: define developer client contracts"
rtk git push origin HEAD:design/self-service-developer-clients
~~~

---

### Task 2: Canonical External-Client Schema and Migration

**Files:**
- Create: src/db/schema/external.ts
- Modify: src/db/drizzle-schema.ts
- Create: drizzle/0096_self_service_developer_clients.sql
- Modify: drizzle/meta/_journal.json
- Modify: src/db/db.integration.test.ts
- Modify: docs/schema.dbml
- Modify: docs/schema.puml

**Interfaces:**
- Produces: externalClient, externalClientRedirectUri, externalClientAudit, externalLink, externalIdentityLink, externalGrant, externalIdempotencyReceipt, and externalErasureAck Drizzle tables.
- Database invariants: active clients have an owner; redirects are HTTPS and unique per client; audit actions are create/update/rotate/revoke.

- [ ] **Step 1: Write the failing schema integration test**

Use setupTestDatabase and direct SQL inserts to prove an active ownerless client fails, an HTTP redirect fails, a duplicate redirect for the same client fails, only create/update/rotate/revoke audit actions succeed, and deleting an owner cascades to the owned client and its redirect/audit rows.

- [ ] **Step 2: Run the test and verify the red state**

~~~bash
rtk pnpm test:integration -- src/db/db.integration.test.ts
~~~

Expected: FAIL because migration 0096 and the Drizzle external schema do not exist.

- [ ] **Step 3: Add the Drizzle source-of-truth model**

Define the existing migration-0094 tables in external.ts so current schema and generated diagrams stop omitting them. Add these fields to externalClient:

~~~typescript
ownerUserId: uuid("owner_user_id").references(() => userProfile.id, {
  onDelete: "cascade",
}),
lastRotatedAt: timestamp("last_rotated_at", { withTimezone: true })
  .notNull()
  .defaultNow(),
~~~

Keep ownerUserId nullable only for revoked legacy rows and add the SQL check equivalent of:

~~~sql
owner_user_id IS NOT NULL OR revoked_at IS NOT NULL
~~~

Define externalClientRedirectUri with clientId plus redirectUri as its composite primary key, an HTTPS check, and a client index. Define externalClientAudit with a UUID primary key, a client foreign key using ON DELETE CASCADE, a nullable actor foreign key using ON DELETE SET NULL, an action check limited to create/update/rotate/revoke, and occurredAt defaulting to now(). This preserves the event while honoring account erasure if an administrator who acted on another owner's client later deletes their account.

- [ ] **Step 4: Write migration 0096**

The migration must:

1. add owner_user_id and last_rotated_at;
2. add the owner and last-rotation indexes;
3. create fitness.external_client_redirect_uri;
4. create fitness.external_client_audit;
5. revoke every existing ownerless client;
6. revoke every active grant belonging to those clients in the same migration;
7. add the active-owner check;
8. replace fitness.account_erasure_relation_is_ownership_neutral so external_client is no longer listed as ownership-neutral; and
9. retain nullable ownership only for the revoked legacy rows.

Use an explicit transaction in the SQL file. Do not put a production owner mapping or user ID in source control.

- [ ] **Step 5: Register and apply the migration**

Append journal index 98 with tag 0096_self_service_developer_clients, then run:

~~~bash
rtk pnpm migrate
~~~

Expected: migration succeeds against the workspace PostgreSQL database and the schema diagram generator updates both docs/schema files.

- [ ] **Step 6: Validate schema behavior and tooling**

Run:

~~~bash
rtk pnpm lint:migrations
rtk pnpm typecheck
rtk pnpm schema:diagram
rtk pnpm test:integration -- src/db/db.integration.test.ts src/db/migrate.integration.test.ts
~~~

Expected: all commands exit 0 and a second schema-diagram run produces no diff.

- [ ] **Step 7: Commit and push**

~~~bash
rtk git add src/db/schema/external.ts src/db/drizzle-schema.ts src/db/db.integration.test.ts drizzle/0096_self_service_developer_clients.sql drizzle/meta/_journal.json docs/schema.dbml docs/schema.puml
rtk git commit -m "feat: add owner-scoped developer client schema"
rtk git push origin HEAD:design/self-service-developer-clients
~~~

---

### Task 3: Atomic Developer-Client Repository

**Files:**
- Create: packages/server/src/repositories/developer-client-repository.ts
- Create: packages/server/src/repositories/developer-client-repository.integration.test.ts

**Interfaces:**
- Consumes: shared DeveloperClientInput, DeveloperClientUpdate, DeveloperClientSummary, and DeveloperClientDetail types; createOpaqueSecret hashes from the existing security primitive.
- Produces:

~~~typescript
class DeveloperClientRepository {
  listOwned(ownerUserId: string): Promise<DeveloperClientSummary[]>;
  getOwned(ownerUserId: string, clientId: string): Promise<DeveloperClientDetail | null>;
  createOwned(
    ownerUserId: string,
    input: DeveloperClientInput,
    secretHash: string,
  ): Promise<DeveloperClientDetail>;
  updateOwned(
    ownerUserId: string,
    clientId: string,
    input: DeveloperClientUpdate,
  ): Promise<DeveloperClientDetail | null>;
  rotateOwned(
    ownerUserId: string,
    clientId: string,
    secretHash: string,
  ): Promise<DeveloperClientDetail | null>;
  revokeOwned(ownerUserId: string, clientId: string): Promise<boolean>;
  listForSupport(): Promise<DeveloperClientSupportSummary[]>;
  revokeForSupport(actorUserId: string, clientId: string): Promise<boolean>;
  hasExactRedirect(clientId: string, redirectUri: string): Promise<boolean>;
}
~~~

- [ ] **Step 1: Write failing real-database tests**

Use setupTestDatabase and create two user profiles. Prove:

- each owner lists and reads only their clients;
- revoked clients remain readable by their owner with status revoked;
- missing and non-owned repository reads both return null;
- create stores only hashSecret(rawSecret), all canonical redirects, lastRotatedAt, and one create audit row;
- update replaces the entire redirect set and appends one update audit row in the same transaction;
- a duplicate or HTTP redirect fails;
- update cannot leave zero redirects;
- rotate changes the hash and lastRotatedAt and appends one rotate audit row atomically;
- revoke changes the client and all active grants and appends one revoke audit row atomically;
- owner mutations on revoked or non-owned rows return null/false without audit writes;
- support revocation records the administrator as actor;
- deleting an owner cascades through their clients, redirects, audits, links, and grants.

- [ ] **Step 2: Run the integration test and verify the red state**

~~~bash
rtk pnpm test:integration -- packages/server/src/repositories/developer-client-repository.integration.test.ts
~~~

Expected: FAIL because the repository does not exist.

- [ ] **Step 3: Implement the repository**

Use executeWithSchema for every raw result. Keep each lifecycle write inside db.transaction. For update, lock the active owned client, update its name, delete and reinsert the full redirect set, append the audit row, and return the committed detail. For revoke, lock the active target, update client.revoked_at and updated_at, revoke every active external_grant for that client, append one audit event, then return true.

Use one private audit helper from every transaction:

~~~typescript
async function appendAudit(
  transaction: TransactionDatabase,
  input: {
    action: "create" | "update" | "rotate" | "revoke";
    actorUserId: string;
    clientId: string;
  },
): Promise<void> {
  await transaction.insert(externalClientAudit).values(input);
}
~~~

listForSupport returns only:

~~~typescript
interface DeveloperClientSupportSummary extends DeveloperClientSummary {
  ownerName: string | null;
  ownerEmail: string | null;
}
~~~

It must not return hashes, raw secrets, redirects, grants, external subjects, audit rows, or owner user IDs.

- [ ] **Step 4: Run the integration test**

~~~bash
rtk pnpm test:integration -- packages/server/src/repositories/developer-client-repository.integration.test.ts
~~~

Expected: PASS.

- [ ] **Step 5: Commit and push**

~~~bash
rtk git add packages/server/src/repositories/developer-client-repository.ts packages/server/src/repositories/developer-client-repository.integration.test.ts
rtk git commit -m "feat: persist developer client lifecycle"
rtk git push origin HEAD:design/self-service-developer-clients
~~~

---

### Task 4: Authenticated Developer Management API

**Files:**
- Create: packages/server/src/routes/api-problem.ts
- Create: packages/server/src/routes/api-problem.test.ts
- Modify: packages/server/src/routes/external-write-api-primitives.ts
- Modify: packages/server/src/routes/external-write-api-primitives.test.ts
- Create: packages/server/src/routes/developer-clients.ts
- Create: packages/server/src/routes/developer-clients.integration.test.ts
- Modify: packages/server/src/index.ts
- Modify: packages/server/src/index.test.ts
- Modify: packages/server/src/index.integration.test.ts

**Interfaces:**
- Consumes: DeveloperClientRepository, shared request/response schemas, getSessionIdFromRequest, validateSession, createOpaqueSecret, buildProblem.
- Produces: the six REST operations specified in Task 1.

- [ ] **Step 1: Write failing problem and developer-route tests**

Add api-problem.test.ts first, expecting buildProblem and sendApiProblem to produce safe mapped and unmapped messages plus the structured 429 envelope. Update the primitive test to import buildProblem from api-problem.ts; this supplies the refactor's red state before moving code.

Mount createDeveloperClientsRouter against setupTestDatabase and cover:

Mount createDeveloperClientsRouter against setupTestDatabase and cover:

- 401 for no or invalid Dofek session;
- list never includes a secret or hash;
- create returns client plus raw secret once, while the database contains only its SHA-256 hash;
- detail, patch, rotate, and revoke work for the owner;
- another authenticated user receives the same 404 problem as a missing client;
- revoked detail follows Decision 1 and revoked mutations return 404;
- malformed names, duplicate canonical redirects, HTTP, credentials, and fragments return 422 with field details;
- sixth create and sixth rotate attempt in one hour return 429 with the structured problem;
- unexpected database failures call captureException and return a safe 503 without identifiers or exception text.

- [ ] **Step 2: Run the tests and verify the red state**

~~~bash
rtk pnpm vitest run --project unit packages/server/src/routes/api-problem.test.ts packages/server/src/routes/external-write-api-primitives.test.ts
rtk pnpm test:integration -- packages/server/src/routes/developer-clients.integration.test.ts
~~~

Expected: FAIL because api-problem.ts and the developer router do not exist.

- [ ] **Step 3: Implement the shared problem response and mount the router**

Move buildProblem into api-problem.ts and add sendApiProblem(response, requestId, status, code, details?) so both REST routers emit one format. Keep crypto and PKCE functions in external-write-api-primitives.ts.

Authenticate with the same cookie-or-Bearer session extraction used by /api/auth/me. Generate client IDs as ext_ plus 18 random base64url bytes and secrets with createOpaqueSecret. Pass only secret.hash to the repository and place secret.value only in the immediate 201/200 response.

Create separate express-rate-limit instances for registration and rotation using Decision 3. Use standard draft-7 headers, disable legacy headers, count all requests, and use sendApiProblem for 429. Mount:

~~~typescript
app.use(
  "/api/developer/clients",
  createDeveloperClientsRouter({ db, repository: new DeveloperClientRepository(db) }),
);
~~~

repository is required, including in tests; do not add an optional production dependency or test-only fallback.

- [ ] **Step 4: Run focused server validation**

~~~bash
rtk pnpm test:integration -- packages/server/src/routes/developer-clients.integration.test.ts packages/server/src/index.integration.test.ts
rtk pnpm vitest run --project unit packages/server/src/routes/api-problem.test.ts packages/server/src/routes/external-write-api-primitives.test.ts packages/server/src/index.test.ts
rtk pnpm --dir=packages/server typecheck
~~~

Expected: PASS.

- [ ] **Step 5: Commit and push**

~~~bash
rtk git add packages/server/src/routes/api-problem.ts packages/server/src/routes/api-problem.test.ts packages/server/src/routes/external-write-api-primitives.ts packages/server/src/routes/external-write-api-primitives.test.ts packages/server/src/routes/developer-clients.ts packages/server/src/routes/developer-clients.integration.test.ts packages/server/src/index.ts packages/server/src/index.test.ts packages/server/src/index.integration.test.ts
rtk git commit -m "feat: expose developer client management api"
rtk git push origin HEAD:design/self-service-developer-clients
~~~

---

### Task 5: Exact Redirect Enforcement and End-to-End External Flow

**Files:**
- Modify: packages/server/src/routes/external-write-api.ts
- Modify: packages/server/src/routes/external-write-api.integration.test.ts

**Interfaces:**
- Consumes: DeveloperClientRepository.hasExactRedirect and canonicalizeDeveloperRedirectUri.
- Preserves: all current link authorize, exchange, status, reissue, erasure acknowledgment, idempotency, and nutrition-write contracts.

- [ ] **Step 1: Replace the test provisioning helper**

Change external-write-api.integration.test.ts to create the owner, session, client, and initial registered redirect through POST /api/developer/clients. Preserve the returned raw credential only in the test process.

Add these assertions before the existing successful PKCE lifecycle:

~~~typescript
const rejected = await startLink({
  redirectUri: "https://unregistered.example/callback",
});
expect(rejected.status).toBe(422);
expect(rejected.headers.get("location")).toBeNull();
expect(await countExternalLinks()).toBe(0);

const nonCanonical = await startLink({
  redirectUri: "https://slack.example.test:443/dofek/callback",
});
expect(nonCanonical.status).toBe(422);
expect(nonCanonical.headers.get("location")).toBeNull();
expect(await countExternalLinks()).toBe(0);
~~~

Then prove the exact URI returned by client creation completes consent, one-time exchange, link status, nutrition write, and revocation.

- [ ] **Step 2: Run the external integration test and verify the red state**

~~~bash
rtk pnpm test:integration -- packages/server/src/routes/external-write-api.integration.test.ts
~~~

Expected: FAIL because link start currently accepts any allowed HTTPS URI and the old administrator provisioning routes still exist.

- [ ] **Step 3: Enforce the registered URI**

Remove POST /clients, /clients/:clientId/rotate, and /clients/:clientId/revoke from the external router. At link start:

1. authenticate the client;
2. parse the request;
3. reject when redirectUri !== canonicalizeDeveloperRedirectUri(redirectUri);
4. verify requested scopes are owned by the client;
5. query hasExactRedirect(clientId, redirectUri);
6. only then insert fitness.external_link.

Add the sixty-per-fifteen-minute link-start limiter from Decision 3 after client authentication and before transaction creation. Its response must use the structured 429 problem.

- [ ] **Step 4: Run focused integration tests**

~~~bash
rtk pnpm test:integration -- packages/server/src/routes/external-write-api.integration.test.ts packages/server/src/routes/developer-clients.integration.test.ts
~~~

Expected: PASS, including the full owner-created PKCE and nutrition-write lifecycle.

- [ ] **Step 5: Commit and push**

~~~bash
rtk git add packages/server/src/routes/external-write-api.ts packages/server/src/routes/external-write-api.integration.test.ts
rtk git commit -m "feat: require registered external redirects"
rtk git push origin HEAD:design/self-service-developer-clients
~~~

---

### Task 6: Administrator Support View and Revocation

**Files:**
- Modify: packages/server/src/routers/admin.ts
- Modify: packages/server/src/routers/admin.test.ts
- Create: packages/web/src/components/DeveloperClientsAdminPanel.tsx
- Create: packages/web/src/components/DeveloperClientsAdminPanel.test.tsx
- Create: packages/web/src/components/DeveloperClientsAdminPanel.stories.tsx
- Modify: packages/web/src/pages/AdminPage.tsx
- Modify: packages/web/src/routes/-admin.test.tsx

**Interfaces:**
- Produces: admin.externalClients query and admin.revokeExternalClient mutation.
- Consumes: DeveloperClientRepository.listForSupport and revokeForSupport.

- [ ] **Step 1: Write failing admin router tests**

Prove a non-admin cannot call either procedure. Prove externalClients returns client ID, name, owner display name/email, scopes, status, creation, and rotation times but no secret hash, redirects, grants, subjects, audits, or user ID. Prove revokeExternalClient requires clientId, atomically revokes grants, writes the administrator actor audit, and returns NOT_FOUND for an already-revoked or absent client.

- [ ] **Step 2: Implement the admin procedures**

Use adminProcedure and the repository; do not add raw SQL to admin.ts. Use a specific NOT_FOUND message:

~~~text
The developer integration was not found or is already revoked.
~~~

The procedure boundary is:

~~~typescript
externalClients: adminProcedure.query(({ ctx }) =>
  new DeveloperClientRepository(ctx.db).listForSupport(),
),
revokeExternalClient: adminProcedure
  .input(z.object({ clientId: z.string().min(1) }))
  .mutation(async ({ ctx, input }) => {
    const revoked = await new DeveloperClientRepository(ctx.db).revokeForSupport(
      ctx.userId,
      input.clientId,
    );
    if (!revoked) throw new TRPCError({ code: "NOT_FOUND", message: notFoundMessage });
    return { revoked: true as const };
  }),
~~~

- [ ] **Step 3: Write failing web support-panel tests**

Cover loading, server error, empty list, active/revoked rows, owner attribution, explicit revoke confirmation, pending state, targeted admin.externalClients invalidation, and surfaced mutation error. Assert secrets, grants, subjects, and audit details are not rendered.

- [ ] **Step 4: Implement the web support panel**

Add a Developer Clients tab to AdminPage. Render DeveloperClientsAdminPanel in that tab and keep the component in its own file so AdminPage.tsx remains under 1,000 lines. Use the existing ModalDialog for revoke confirmation.

Add stories for loading, empty, error, active, and revoked states. The component must render those states through props from a small production container, not through test-only branches.

Wire only the new tab into the existing page:

~~~tsx
{activeTab === "developerClients" ? <DeveloperClientsAdminPanel /> : null}
~~~

- [ ] **Step 5: Run focused admin checks**

~~~bash
rtk pnpm vitest run --project unit packages/server/src/routers/admin.test.ts packages/web/src/components/DeveloperClientsAdminPanel.test.tsx packages/web/src/routes/-admin.test.tsx
rtk pnpm --dir=packages/server typecheck
rtk pnpm --dir=packages/web typecheck
~~~

Expected: PASS.

- [ ] **Step 6: Commit and push**

~~~bash
rtk git add packages/server/src/routers/admin.ts packages/server/src/routers/admin.test.ts packages/web/src/components/DeveloperClientsAdminPanel.tsx packages/web/src/components/DeveloperClientsAdminPanel.test.tsx packages/web/src/components/DeveloperClientsAdminPanel.stories.tsx packages/web/src/pages/AdminPage.tsx packages/web/src/routes/-admin.test.tsx
rtk git commit -m "feat: add developer client support controls"
rtk git push origin HEAD:design/self-service-developer-clients
~~~

---

### Task 7: Web Developer Integrations List and Creation

**Files:**
- Create: packages/web/src/lib/developer-clients.ts
- Create: packages/web/src/lib/developer-clients.test.ts
- Create: packages/web/src/components/DeveloperClientForm.tsx
- Create: packages/web/src/components/DeveloperClientForm.test.tsx
- Create: packages/web/src/components/DeveloperClientForm.stories.tsx
- Create: packages/web/src/components/DeveloperClientSecretDialog.tsx
- Create: packages/web/src/components/DeveloperClientSecretDialog.test.tsx
- Create: packages/web/src/components/DeveloperClientSecretDialog.stories.tsx
- Create: packages/web/src/pages/DeveloperIntegrationsPage.tsx
- Create: packages/web/src/pages/DeveloperIntegrationsPage.test.tsx
- Create: packages/web/src/routes/developer-integrations/index.tsx
- Modify: packages/web/src/pages/SettingsPage.tsx
- Modify: packages/web/src/pages/settingsCategories.ts
- Modify: packages/web/src/routes/settings.test.tsx
- Modify: packages/web/src/routeTree.gen.ts

**Interfaces:**
- Consumes: createDeveloperClientsApi and shared schemas.
- Produces: /developer-integrations list/create route and a link from Advanced settings.

- [ ] **Step 1: Write the cookie transport test**

Mock fetch and prove the web adapter prefixes no host, sets credentials: "include", preserves JSON headers, parses the shared contract, and surfaces DeveloperClientsApiError.message without wrapping it in a generic string.

- [ ] **Step 2: Write failing form and secret-dialog tests**

DeveloperClientForm must:

- collect a trimmed human-readable name;
- render one redirect input initially and add/remove controls;
- prevent removal of the last redirect;
- display nutrition:write as the only checked, disabled scope;
- show shared schema messages for HTTP, fragment, credentials, malformed, and duplicate canonical URIs.

DeveloperClientSecretDialog must:

- display client ID and raw secret;
- explain that the secret cannot be recovered;
- copy each value with navigator.clipboard.writeText;
- report clipboard exceptions through captureException and show manual-copy guidance;
- clear its parent-held secret when dismissed.

- [ ] **Step 3: Write the failing list/create page test**

Use TanStack Query with query key ["developer-clients"]. Cover initial loading, server error, empty list, active/revoked summaries, create submission, targeted list invalidation, one-time secret dialog, and no raw secret in query data after dialog dismissal.

- [ ] **Step 4: Implement the web list/create route**

Create a thin route component and keep the page in pages/. The page links each client ID to /developer-integrations/:clientId. Show the fixed scope in readable copy and include:

~~~text
Your integration sends users through Dofek sign-in and consent. Keep the PKCE verifier in your integration and send the bearer client credential only in the Authorization header.
~~~

Link “External API contract” to the canonical GitHub main-branch docs/external-api.md and include a small S256 PKCE request example with placeholders only.

Use a query for non-secret list data and local state for the create secret:

~~~typescript
const clients = useQuery({
  queryKey: ["developer-clients"],
  queryFn: () => developerClientsApi.list(),
});
const [createdSecret, setCreatedSecret] = useState<DeveloperClientSecret | null>(null);
~~~

Add the Advanced-settings destination from Decision 4 and regenerate the route tree:

~~~bash
rtk pnpm --dir=packages/web exec tanstack-router generate
~~~

- [ ] **Step 5: Add Storybook coverage**

Stories must cover default form, validation error, submitting form, visible one-time secret, copy failure guidance, list loading, list empty, list error, active list, and revoked list. Do not use real credentials.

- [ ] **Step 6: Run web checks**

~~~bash
rtk pnpm vitest run --project unit packages/web/src/lib/developer-clients.test.ts packages/web/src/components/DeveloperClientForm.test.tsx packages/web/src/components/DeveloperClientSecretDialog.test.tsx packages/web/src/pages/DeveloperIntegrationsPage.test.tsx packages/web/src/routes/settings.test.tsx
rtk pnpm --dir=packages/web typecheck
~~~

Expected: PASS.

- [ ] **Step 7: Commit and push**

~~~bash
rtk git add packages/web/src/lib/developer-clients.ts packages/web/src/lib/developer-clients.test.ts packages/web/src/components/DeveloperClientForm.tsx packages/web/src/components/DeveloperClientForm.test.tsx packages/web/src/components/DeveloperClientForm.stories.tsx packages/web/src/components/DeveloperClientSecretDialog.tsx packages/web/src/components/DeveloperClientSecretDialog.test.tsx packages/web/src/components/DeveloperClientSecretDialog.stories.tsx packages/web/src/pages/DeveloperIntegrationsPage.tsx packages/web/src/pages/DeveloperIntegrationsPage.test.tsx packages/web/src/routes/developer-integrations/index.tsx packages/web/src/pages/SettingsPage.tsx packages/web/src/pages/settingsCategories.ts packages/web/src/routes/settings.test.tsx packages/web/src/routeTree.gen.ts
rtk git commit -m "feat: add web developer client creation"
rtk git push origin HEAD:design/self-service-developer-clients
~~~

---

### Task 8: Web Client Detail, Editing, Rotation, and Revocation

**Files:**
- Create: packages/web/src/pages/DeveloperClientDetailPage.tsx
- Create: packages/web/src/pages/DeveloperClientDetailPage.test.tsx
- Create: packages/web/src/routes/developer-integrations/$clientId.tsx
- Modify: packages/web/src/routeTree.gen.ts

**Interfaces:**
- Consumes: DeveloperClientForm, DeveloperClientSecretDialog, and the web developerClientsApi.
- Produces: /developer-integrations/:clientId detail route.

- [ ] **Step 1: Write the failing detail-page tests**

Cover:

- initial loading and server error;
- display name, every redirect, nutrition write scope, created time, last-rotated time, and active/revoked status;
- edit submits the full canonical redirect set and replaces displayed data;
- rotate requires explicit confirmation, shows a new one-time secret, and invalidates only this detail plus the list;
- revoke requires explicit confirmation, invalidates list/detail, and renders revoked status;
- server errors use error.message;
- revoked detail disables edit, rotate, and revoke;
- neither grants, external subjects, nor audit rows appear.

- [ ] **Step 2: Implement the detail route**

Use the shared form in edit mode and ModalDialog for rotate/revoke confirmations. Never place a mutation's raw-secret response in TanStack Query data. Keep it only in local component state and clear it on dialog close and unmount.

The rotate success path is:

~~~typescript
const rotated = await developerClientsApi.rotate(clientId);
setRotatedSecret(rotated);
await Promise.all([
  queryClient.invalidateQueries({ queryKey: ["developer-clients"] }),
  queryClient.invalidateQueries({ queryKey: ["developer-clients", clientId] }),
]);
~~~

Regenerate the route tree and verify the literal $clientId path is staged with shell escaping.

- [ ] **Step 3: Run focused checks**

~~~bash
rtk pnpm vitest run --project unit packages/web/src/pages/DeveloperClientDetailPage.test.tsx packages/web/src/components/DeveloperClientForm.test.tsx packages/web/src/components/DeveloperClientSecretDialog.test.tsx
rtk pnpm --dir=packages/web typecheck
~~~

Expected: PASS.

- [ ] **Step 4: Commit and push**

~~~bash
rtk git add packages/web/src/pages/DeveloperClientDetailPage.tsx packages/web/src/pages/DeveloperClientDetailPage.test.tsx 'packages/web/src/routes/developer-integrations/$clientId.tsx' packages/web/src/routeTree.gen.ts
rtk git commit -m "feat: manage developer clients on web"
rtk git push origin HEAD:design/self-service-developer-clients
~~~

---

### Task 9: Mobile Developer Integrations List and Creation

**Files:**
- Modify: packages/mobile/package.json
- Modify: pnpm-lock.yaml
- Create: packages/mobile/lib/developer-clients.ts
- Create: packages/mobile/lib/developer-clients.test.ts
- Create: packages/mobile/components/DeveloperClientForm.tsx
- Create: packages/mobile/components/DeveloperClientForm.test.tsx
- Create: packages/mobile/components/DeveloperClientForm.stories.tsx
- Create: packages/mobile/components/DeveloperClientSecretPanel.tsx
- Create: packages/mobile/components/DeveloperClientSecretPanel.test.tsx
- Create: packages/mobile/components/DeveloperClientSecretPanel.stories.tsx
- Create: packages/mobile/app/developer-integrations/index.tsx
- Create: packages/mobile/app-tests/developer-integrations-index.test.tsx
- Create: packages/mobile/app-stories/developer-integrations.stories.tsx
- Modify: packages/mobile/app/settings.tsx
- Modify: packages/mobile/app-tests/settings.test.tsx
- Modify: packages/mobile/app-stories/settings.stories.tsx

**Interfaces:**
- Consumes: createDeveloperClientsApi, useAuth().serverUrl, useAuth().sessionToken, Expo Clipboard, Expo Router.
- Produces: /developer-integrations list/create screen and Advanced-settings navigation.

- [ ] **Step 1: Install the Expo-compatible clipboard module**

Run:

~~~bash
rtk pnpm --dir=packages/mobile exec expo install expo-clipboard
~~~

Expected: Expo selects the SDK-compatible current release and updates package.json and pnpm-lock.yaml. Do not install with npm or copy a version from an older branch.

- [ ] **Step 2: Write the bearer transport and component tests**

Prove the mobile adapter prefixes serverUrl, sends Authorization: Bearer sessionToken, and fails immediately with “Sign in again to manage developer integrations.” when no token exists.

Mirror the web form behaviors. DeveloperClientSecretPanel uses Clipboard.setStringAsync, reports unexpected failures with captureException, provides manual-copy guidance, and invokes onDismiss so the screen clears the secret.

- [ ] **Step 3: Write the failing route test**

In app-tests, mock only the network adapter, Expo Clipboard, and navigation boundaries. Cover loading, error, empty, active/revoked list, create, one-time secret, copy, dismissal, targeted query invalidation, and navigation to /developer-integrations/:clientId. Assert server error messages are displayed.

- [ ] **Step 4: Implement the route and settings link**

Keep route code under app/ and all tests/stories outside it. Use QueryStatePanel for blocking loading/error/empty states and keep prior list data visible during background refresh. Add a Developer integrations row under Advanced settings that pushes /developer-integrations.

Use the same external API documentation URL and PKCE explanation as web, opening it with openExternalUrl.

Create the authenticated adapter from production auth state:

~~~typescript
const developerClientsApi = createMobileDeveloperClientsApi({
  serverUrl: auth.serverUrl,
  sessionToken: auth.sessionToken,
});
~~~

- [ ] **Step 5: Add mobile stories**

Cover default form, form validation, secret visible, clipboard failure, list loading, empty, error, active, and revoked. Use synthetic IDs and secrets.

- [ ] **Step 6: Run mobile checks**

~~~bash
rtk pnpm vitest run --project mobile packages/mobile/lib/developer-clients.test.ts packages/mobile/components/DeveloperClientForm.test.tsx packages/mobile/components/DeveloperClientSecretPanel.test.tsx packages/mobile/app-tests/developer-integrations-index.test.tsx packages/mobile/app-tests/settings.test.tsx
rtk pnpm --dir=packages/mobile typecheck
rtk pnpm check:mobile-app-routes
~~~

Expected: PASS and no test/story/helper route is discovered under app/.

- [ ] **Step 7: Commit and push**

~~~bash
rtk git add packages/mobile/package.json pnpm-lock.yaml packages/mobile/lib/developer-clients.ts packages/mobile/lib/developer-clients.test.ts packages/mobile/components/DeveloperClientForm.tsx packages/mobile/components/DeveloperClientForm.test.tsx packages/mobile/components/DeveloperClientForm.stories.tsx packages/mobile/components/DeveloperClientSecretPanel.tsx packages/mobile/components/DeveloperClientSecretPanel.test.tsx packages/mobile/components/DeveloperClientSecretPanel.stories.tsx packages/mobile/app/developer-integrations/index.tsx packages/mobile/app-tests/developer-integrations-index.test.tsx packages/mobile/app-stories/developer-integrations.stories.tsx packages/mobile/app/settings.tsx packages/mobile/app-tests/settings.test.tsx packages/mobile/app-stories/settings.stories.tsx
rtk git commit -m "feat: create developer clients on mobile"
rtk git push origin HEAD:design/self-service-developer-clients
~~~

---

### Task 10: Mobile Client Detail, Editing, Rotation, and Revocation

**Files:**
- Create: packages/mobile/app/developer-integrations/[clientId].tsx
- Create: packages/mobile/app-tests/developer-integrations-detail.test.tsx
- Modify: packages/mobile/app-stories/developer-integrations.stories.tsx

**Interfaces:**
- Consumes: mobile developerClientsApi, DeveloperClientForm, DeveloperClientSecretPanel.
- Produces: /developer-integrations/:clientId mobile detail screen.

- [ ] **Step 1: Write the failing route test**

Mirror the web detail acceptance cases. Use React Native Alert for distinct rotate and revoke confirmations, assert cancellation sends no request, and assert a confirmed revoke immediately invalidates the list and detail queries. Verify revoked detail is readable but all mutation controls are disabled.

- [ ] **Step 2: Implement the detail screen**

Read clientId with useLocalSearchParams and reject a missing/non-string value before calling the API. Use formatDateTime for server timestamps. Keep the rotated raw secret only in local state, clear it when the panel closes or the route unmounts, and report unexpected local failures with captureException.

Use distinct confirmations:

~~~typescript
Alert.alert("Rotate client secret?", rotateWarning, [
  { text: "Cancel", style: "cancel" },
  { text: "Rotate", style: "destructive", onPress: () => void rotateSecret() },
]);
Alert.alert("Revoke developer integration?", revokeWarning, [
  { text: "Cancel", style: "cancel" },
  { text: "Revoke", style: "destructive", onPress: () => void revokeClient() },
]);
~~~

- [ ] **Step 3: Extend route stories**

Add detail loading, error, active, revoked, edit, rotate-confirmation, one-time-secret, and revoke-confirmation stories. Keep fixtures under app-stories.

- [ ] **Step 4: Run mobile checks**

~~~bash
rtk pnpm vitest run --project mobile packages/mobile/app-tests/developer-integrations-detail.test.tsx packages/mobile/components/DeveloperClientForm.test.tsx packages/mobile/components/DeveloperClientSecretPanel.test.tsx
rtk pnpm --dir=packages/mobile typecheck
rtk pnpm check:mobile-app-routes
~~~

Expected: PASS.

- [ ] **Step 5: Commit and push**

~~~bash
rtk git add 'packages/mobile/app/developer-integrations/[clientId].tsx' packages/mobile/app-tests/developer-integrations-detail.test.tsx packages/mobile/app-stories/developer-integrations.stories.tsx
rtk git commit -m "feat: manage developer clients on mobile"
rtk git push origin HEAD:design/self-service-developer-clients
~~~

---

### Task 11: Public Contract and Human Documentation

**Files:**
- Modify: packages/server/openapi/external-v1.yaml
- Modify: docs/external-api.md

**Interfaces:**
- Consumes: final route and response shapes from Tasks 1, 4, and 5.
- Produces: public external-integration contract matching deployed behavior.

- [ ] **Step 1: Update OpenAPI**

Remove the three administrator provisioning paths from /api/external/v1. In LinkStartRequest, retain redirectUri as required and describe it as:

~~~text
The complete canonical HTTPS callback URI. It must exactly match one URI registered for the authenticated developer client.
~~~

Document 429 for link start and preserve every existing grant/write schema. Do not add /api/developer/clients to the public integration contract; it is the authenticated first-party management surface, and its executable contract is the shared Zod module.

- [ ] **Step 2: Update docs/external-api.md**

Replace administrator provisioning with the owner self-service flow and link to /developer-integrations in product copy. Document canonical registration followed by exact string comparison, cite RFC 9700 section 4.1 and RFC 7636, and state that Slack is a separately deployed normal client that owns its Slack tokens, PKCE verifier/state, grants, drafts, dedupe data, and user-facing errors.

Remove stale “Existing implementation anchors” that name deleted Slack files. Retain the current provider-agnostic nutrition, idempotency, erasure, and bearer-token contracts.

- [ ] **Step 3: Validate docs and OpenAPI**

~~~bash
rtk pnpm lint:openapi
rtk pnpm lint
~~~

Expected: PASS.

- [ ] **Step 4: Commit and push**

~~~bash
rtk git add packages/server/openapi/external-v1.yaml docs/external-api.md
rtk git commit -m "docs: publish developer client contract"
rtk git push origin HEAD:design/self-service-developer-clients
~~~

---

### Task 12: Full Verification and Non-Deploy Handoff

**Files:**
- Verify all changed files.
- Do not modify deploy configuration, Infisical, Worker secrets, or production state.

- [ ] **Step 1: Run focused unit and mobile suites**

~~~bash
rtk pnpm vitest run --project unit packages/auth/src/developer-clients.test.ts packages/server/src/routes/api-problem.test.ts packages/server/src/routes/external-write-api-primitives.test.ts packages/server/src/routers/admin.test.ts packages/web/src/lib/developer-clients.test.ts packages/web/src/components/DeveloperClientForm.test.tsx packages/web/src/components/DeveloperClientSecretDialog.test.tsx packages/web/src/components/DeveloperClientsAdminPanel.test.tsx packages/web/src/pages/DeveloperIntegrationsPage.test.tsx packages/web/src/pages/DeveloperClientDetailPage.test.tsx
rtk pnpm vitest run --project mobile packages/mobile/lib/developer-clients.test.ts packages/mobile/components/DeveloperClientForm.test.tsx packages/mobile/components/DeveloperClientSecretPanel.test.tsx packages/mobile/app-tests/developer-integrations-index.test.tsx packages/mobile/app-tests/developer-integrations-detail.test.tsx packages/mobile/app-tests/settings.test.tsx
~~~

Expected: PASS.

- [ ] **Step 2: Run real-database integration suites**

~~~bash
rtk pnpm test:integration -- src/db/db.integration.test.ts src/db/migrate.integration.test.ts packages/server/src/repositories/developer-client-repository.integration.test.ts packages/server/src/routes/developer-clients.integration.test.ts packages/server/src/routes/external-write-api.integration.test.ts packages/server/src/index.integration.test.ts
~~~

Expected: PASS against the workspace's real PostgreSQL service.

- [ ] **Step 3: Run repository-required pre-push checks**

~~~bash
rtk pnpm lint
rtk pnpm test:changed
rtk pnpm typecheck
rtk pnpm --dir=packages/server typecheck
rtk pnpm --dir=packages/web typecheck
rtk pnpm --dir=packages/mobile typecheck
rtk pnpm --dir=packages/web build
rtk pnpm check:mobile-app-routes
~~~

Expected: every command exits 0. Do not increase size thresholds or suppress failures.

- [ ] **Step 4: Perform security searches**

~~~bash
rtk rg -n '(logger|captureException).*?(clientSecret|secret_hash|code|accessToken|Slack|userId)' packages/server/src/routes packages/server/src/repositories/developer-client-repository.ts packages/web/src/lib/developer-clients.ts packages/web/src/pages packages/mobile/lib/developer-clients.ts packages/mobile/app/developer-integrations
rtk rg -n '/api/external/v1/clients' packages docs/external-api.md src
~~~

Expected: the first search has no sensitive logging/telemetry call and the second finds no old administrator provisioning path. Raw-secret names otherwise appear only in typed create/rotate response handling and synthetic tests.

- [ ] **Step 5: Review the diff and push the final implementation state**

~~~bash
rtk git diff --check origin/main...HEAD
rtk git status --short
rtk git push origin HEAD:design/self-service-developer-clients
~~~

Expected: no unstaged implementation changes and the remote branch contains every task commit. Stop here; do not configure secrets or deploy.

## Separate Slack Worker Plan and Rollout Handoff

The Dofek repository cannot supply exact Worker file paths or commands because the Worker source is absent. After the Worker repository is identified, create a separate repository-local Superpowers plan that reads that repository's guidance and covers:

- /link-dofek returning an ephemeral Slack Block Kit URL button;
- cryptographically random PKCE verifier, S256 challenge, and state generation;
- bounded, single-use callback state storage;
- callback state verification followed by Dofek one-time code exchange;
- storage of only the user-specific Dofek grant/token data required by the Worker;
- a direct Slack confirmation after successful exchange and a browser “Account linked” response;
- safe actionable Slack replies for link-start, callback, and exchange failures;
- captureException/Worker observability for underlying exceptions without Slack IDs, Dofek IDs, credentials, codes, tokens, or raw payloads;
- tests for the ephemeral button, completed callback direct message, browser result, rejected Dofek link start, invalid/expired state, and exchange failure.

Only after both repositories pass their checks should an authorized operator:

1. create the Slack Food Bot client through the self-service UI with the Worker's canonical HTTPS callback;
2. copy the one-time client ID and secret directly into the Worker's approved secret store;
3. deploy Dofek, then deploy the Worker;
4. complete the production PKCE link and nutrition-write flow with a test Dofek account;
5. verify the callback confirmation in Slack, the browser completion page, Dofek audit event, exact redirect enforcement, and absence of sensitive logs;
6. announce availability only after those checks pass.

## Self-Review

**Spec coverage**

- Owner-scoped schema, redirects, secret hashing, timestamps, revocation, audit, and legacy handling: Tasks 2–3.
- Six authenticated developer API operations and privacy-preserving ownership: Tasks 3–4.
- Exact registered redirect, S256 PKCE, consent, exchange, grant, and nutrition write: Task 5.
- Administrator support-only view and revoke: Task 6.
- Web list/create/detail/edit/rotate/revoke and one-time secret copy: Tasks 7–8.
- Mobile parity and Expo Router hygiene: Tasks 9–10.
- Rate limiting and safe observability: Tasks 4–5 and final security review.
- External API/OpenAPI updates: Task 11.
- Slack Worker behavior and rollout: explicitly split into a second repository-local plan because its source is not present; the acceptance contract and rollout order are recorded above.

**Flagged gaps**

- Decisions 1–5 require user confirmation before implementation.
- A separate Slack Worker repository plan is required for executable file-level steps.
- Production inventory is required before migration review to confirm whether every legacy client is intentionally revoked.
- Secret configuration and deployment require separate authorization and are not performed by this plan.

**Placeholder scan**

- The plan contains no deferred implementation placeholders. The missing Slack file paths are treated as a hard repository boundary, not guessed.

**Type consistency**

- Owner responses use DeveloperClientSummary and DeveloperClientDetail.
- Only create and rotate return DeveloperClientSecret.
- The only scope is nutrition:write.
- Audit actions are create, update, rotate, and revoke.
- Canonical redirects are produced by canonicalizeDeveloperRedirectUri and compared byte-for-byte by hasExactRedirect.
- Both clients use the same DeveloperClientsApi method names and REST paths.
