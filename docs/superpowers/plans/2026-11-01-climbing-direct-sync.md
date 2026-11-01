# Climbing Direct Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Add verified per-user automatic sync for Crimpd and Vertical-Life on web and mobile.

**Architecture:** Extend the existing provider identities, encrypted credential repository and scheduled sync pipeline. Reuse Crimpd's documented ZIP importer; use native Vertical-Life ascent identities only after server authentication and its lifecycle are verified. Preserve existing upload support and canonical records.

**Tech Stack:** Existing TypeScript, Zod, Drizzle, Vitest, MSW, yauzl, impit, React and React Native. No new dependencies are proposed.

**Spec:** `docs/superpowers/specs/2026-11-01-climbing-direct-sync-design.md` (approved).

## Global Constraints

- Stay on `witty-ferret`; no branch switching or production deployment.
- Verify renewable authentication before implementing the corresponding connector.
- Store credentials per user; no deployment-wide user credentials or secret output.
- Reuse canonical records and preserve raw facts, attachments and unknown values.
- Keep uploads available alongside Connect and Sync on both platforms.
- Do not reconcile remote absence from uploads, partial fetches or failed authentication.
- Do not invent a Vertical-Life client registration, token grant or source contract.
- Commit meaningful verified changes and automatically push every new commit.

## Review Focus

- Refresh rotates credentials: persist replacement tokens before downloading data.
- HTTP 200 can carry a malformed or unsuccessful payload: reject it before writes.
- CSV uploads can follow native-ID sync: resolve the same records or reject ambiguity.
- An empty export is not proof of deletion: preserve upload/import absence semantics.
- A provider can support both sync and uploads: neither client may hide either action.

### Task 1: Verify direct authentication and record source evidence

**Files:** `docs/climbing-logbook-api-research.md`.

**Interfaces:** Establish concrete request/response contracts before Tasks 2 and 3 consume them. Use the existing Firefox session for owner access; never print credentials.

- [ ] Verify Crimpd initial login through `POST https://api.crimpd.com/auth/jwt`, token renewal through `/auth/refresh`, and subsequent authenticated export access independently of the app's interceptors. Capture only response shape, status and expiry metadata.
- [x] Inspect the existing owner's ZIP header and record whether populated workouts are available; compare populated records against the published [export contract](https://crimpd.com/docs/data-export/) when available.
- [x] Verify Vertical-Life transport with the existing `impit` client. On November 1, the Chrome and Firefox transports returned HTTP 200 for the home page and HTTP 401 JSON for unauthenticated export, while Node fetch returned Cloudflare HTTP 403.
- [x] Trace owner login and renewal using the observed `/login` authorization-code/PKCE flow. The public `8a-nu` client rejected a password-grant probe with `unauthorized_client`; do not implement a password grant based on realm-wide discovery.
- [x] Verify server-authenticated owner identity, four ascent categories and repeated reads after renewal. If the required grant/session cannot be obtained, record the exact blocker and leave Vertical-Life product behavior unchanged; continue independent Crimpd work.
- [x] Update research with methods, vendor sources and remaining validation gaps, without secrets. Review the evidence gate before implementing each provider.

### Task 2: Crimpd automatic ZIP sync

**Files:** Create `src/providers/crimpd/client.ts`, `client.test.ts`, `provider.test.ts`; modify `provider.ts`, `provider.integration.test.ts`; retain existing `archive.ts` and `parser.ts` unless observed source data requires changes.

**Interfaces:** `CrimpdClient` accepts `typeof globalThis.fetch`; exposes `login(username: string, password: string): Promise<TokenSet>`, `refresh(tokens: TokenSet): Promise<TokenSet>` and `downloadExport(tokens: TokenSet, signal?: AbortSignal): Promise<Uint8Array>`. `CrimpdProvider` implements `SyncProvider`, `authSetup(): ProviderAuthSetup` and `sync(run: SyncRun): Promise<SyncResult>`.

- [x] Write failing client tests: successful login returns access/refresh credentials and native account identity; malformed success fails; invalid login produces an actionable error; refresh uses the saved refresh token; export sends bearer authentication and rejects an error response.
- [x] Run `pnpm exec vitest run --project unit src/providers/crimpd/client.test.ts`; confirm failures identify missing behavior, then implement the observed protocol through the existing provider HTTP boundary and Zod schemas.
- [x] Run the same tests and confirm they pass.
- [x] Write failing provider tests for missing user/credentials, expired-token refresh, refresh persistence before export, cancellation and non-successful sync reporting. Add database/MSW cases proving upload and sync share workout identities and preserve manual climbing attachments, raw sets and user isolation.
- [x] Run focused unit tests and database tests through `pnpm test:integration -- <file>` using the repository integration-test instructions; confirm failures before implementation.
- [x] Implement sync by loading the user's credentials, refreshing when required, downloading the ZIP to a private temporary directory, calling `importCrimpdExportFile(db, filePath, userId)` and removing the temporary file in `finally`. Report unexpected failures through existing Sentry/sync error paths. Do not retire missing workouts from this export path without a proven authoritative contract.
- [x] Run focused unit and integration checks, inspect the diff and commit/push this independently testable provider change.

### Task 3: Vertical-Life native logbook sync

**Files:** Create `src/providers/eight-a/client.ts`, `client.test.ts`, `ascent.ts`, `ascent.test.ts`, `identity.ts`, `identity.test.ts`; modify `provider.ts`, `parser.ts`, `provider.integration.test.ts`.

**Interfaces:** Following successful Task 1 verification, `EightAClient.fetchLogbook(tokens: TokenSet, persistTokens: (tokens: TokenSet) => Promise<void>, signal?: AbortSignal): Promise<SourceClimbingLogEntry[]>` provides complete, validated source entries. Provider authentication must implement the verified grant; pin its exact exchange and refresh interfaces in these working notes before writing production code. `EightAProvider` retains ID `eight-a` and implements the existing `SyncProvider` contract.

- [x] Use verified populated ascent responses as sanitized fixtures. Write failing tests for native IDs, source dates/categories/grades, projects/repeats/duplicates, malformed payloads and explicit unknown values.
- [x] Write failing pagination tests covering zero-based pages, empty-page termination, repeated pages and failure after a successful page. Assert no authoritative write follows an incomplete fetch.
- [x] Implement only the verified grant/session lifecycle, transport and source parser; run focused unit tests RED then GREEN. Do not create a placeholder client if Task 1 is blocked.
- [x] Write database tests for CSV-before-sync, sync-before-CSV, repeated uploads, edits, ambiguous duplicate occurrences, manual attachments and separate users. Assert ambiguous cross-path matches reject without partial writes.
- [x] Implement one provider-local identity resolver for both upload and sync, migrating only proven one-to-one existing identities. If verified fields do not allow sound identity resolution, present that concrete blocker before shipping.
- [x] Use existing climbing persistence/snapshot helpers, reconciling only a complete authoritative response. Run unit and real-database tests, review and commit/push.

### Task 4: Connection lifecycle and both clients

**Files:** `src/jobs/provider-registration.ts`, `packages/server/src/routers/sync-helpers.ts`, applicable sync scheduling/processing metadata, `src/account-erasure/remote-snapshot.ts`, `packages/web/src/components/DataSourcesPanel.tsx` and tests/stories, `packages/mobile/app/providers/index.tsx` and `app-tests/providers/index.test.tsx`, provider card components/tests/stories as needed.

**Interfaces:** Consume provider `authSetup()` and `SyncProvider` contracts; retain upload configurations and provider IDs. Generic client behavior must support a source with both account sync and file upload.

- [x] Write failing auth-policy, provider-discovery and lifecycle tests for implemented connectors, including reconnect ownership and explicit erasure limitations where upstream revocation is unverified.
- [x] Write failing web/mobile tests proving Connect, Sync, upload, pending state and actionable error messages remain available in the applicable connected/disconnected states.
- [x] Update minimal shared wiring and client rendering; update stories alongside modified components. Do not advertise a connector whose Task 1 gate remains blocked.
- [x] Run focused unit/mobile/lifecycle tests and all relevant typechecks, inspect visual states through existing browser/story tooling, review and commit/push.

### Task 5: Final verification and delivery

**Files:** `docs/climbing-logbook-api-research.md`, `docs/climbing-providers.md`, `src/providers/README.md`, implementation working notes and this checklist.

- [x] Update current docs with exact supported behavior, sources, connection instructions and any external blocker; distinguish browser checks, independent server checks and mocked tests.
- [x] Run required lint, typechecks, Docker-free unit/mobile tests and focused real-database integration tests using current workspace dependencies. Follow `docs/testing.md` and applicable skills.
- [x] Obtain a fresh whole-change review, resolve important findings with failing regression tests first, then repeat affected checks.
- [x] Verify owner authentication, renewal and sync using the implemented connector wherever access is available. Do not write fake workouts/ascents into upstream accounts.
- [x] Commit/push final reviewed changes; report validation, remaining access prerequisites and a short retrospective. Finish the progress run only when all required work is complete or explicitly resolved by the user.

## Final verification — November 1, 2026

Both sync providers, the strict CSV/native transition, lifecycle wiring, and web/mobile actions are implemented. Strict matching was approved to reject unmatched connected uploads and to import new ascents through native sync; CSV uploads retain provenance without replacing native facts. See the [identity resolver](../../../src/providers/eight-a/identity.ts).

The final independent review found two important issues: incomplete CSV equality and a refresh limit across the whole logbook. Failing regressions reproduced both before fixes. Matching now compares all verified shared facts and complete retained CSV payloads, rejects unprovable initial matches, and supports distinct source areas. Renewal is checked throughout pagination with one authentication retry per request and durable token replacement before continuing. No minor findings were deferred.

Validation: 23,902 unit/mobile tests passed (19 skipped), 51 focused database integration tests passed, lint and root/server/web/mobile TypeScript checks passed. Both web/mobile source states and narrow mobile layout were inspected in Storybook. Tests and [live source evidence](../../climbing-logbook-api-research.md) remain distinct: renewal and direct owner reads succeeded for both providers, but both owner histories were empty. Scripted successful password submissions and populated owner/indoor histories remain unverified. The unchecked initial-login item records that limitation rather than claiming a live check that did not occur.

## Approved review follow-up — November 1, 2026

The owner approved empty source attempts for projects with unknown tries and a
100 MiB streamed Crimpd download limit. The [writer](../../../src/db/climbing-log-sync.ts)
now retains occurrences without inventing attempts; the [load repository](../../../packages/server/src/repositories/analytical-training-load-repository.ts)
keeps empty whole-climb attempt coverage unavailable. Crimpd's [client](../../../src/providers/crimpd/client.ts)
streams into the existing private file and cancels oversized or aborted streams.

Failing parser, writer, download-limit and real-database reporting regressions
preceded implementation. Validation passed: 23,991 unit/mobile tests (19 skipped),
61 writer/provider/reporting database tests, 12 Crimpd database tests, lint and
root/server/web/mobile types. Changed provider modules score 92.37% in the local
mutation run. A main-branch asynchronous-bootstrap fixture race in the iOS gate
was corrected; all eight real Expo bridge tests pass. See the
[incident evidence](../../production-incident-baseline.md#2026-11-01--whoop-bridge-fixture-races-asynchronous-bootstrap).
PR review responses and replacement CI are the remaining delivery checkpoints.
