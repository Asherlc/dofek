# theCrag Official API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Replace public ascent scraping with official account-scoped logbook sync.

**Architecture:** Use the existing manual access-token form and encrypted credential store. Fetch paginated JSON through the shared HTTP boundary, map raw ascents into canonical climbing entries, and advance account/connection-scoped operational progress only after persistence succeeds.

**Tech Stack:** TypeScript, Zod, Drizzle/Postgres, Vitest, MSW, existing React/React Native forms.

**Spec:** [Approved design](../specs/2026-10-30-thecrag-official-api-design.md).

## Global Constraints

- One canonical personal-key ingestion path; existing public identities require reconnection.
- Preserve `thecrag:<ascent-id>`, canonical records, workout attachments and unknown fields.
- Conceal API keys on web/mobile, never emit keys or private response bodies to diagnostics.
- Full initial import, then upstream-epoch incremental updates; full requests bypass progress.
- No new dependencies, deployment variables, fallback transports or retry knobs.
- Public catalogue lookup remains separate; retain its transport dependencies.

## Review Focus

- A new connection to the same account must reimport full history despite an older cursor.
- One failed later page must not advance progress or retire existing records.
- Equal-epoch edits must remain available for replay; empty deltas must not move the cursor.
- Missing source rope/grade/attempt details must stay unknown rather than imply a send or lead.
- Private notes and upstream error payloads must not leak into error monitoring.

### Task 1: Official API client and mapping

**Files:** Create `src/providers/thecrag/client.ts`, `client.test.ts`, `mapping.ts`, `mapping.test.ts`; update local test helpers.

**Interfaces:** `TheCragClient(fetchFn, key)` supplies validated paginated account/ascents JSON. `mapTheCragAscent(ascent, accountId)` returns `SourceClimbingLogEntry`. Zod-inferred source types are consumed by both modules.

- [x] Write client tests for header-only credentials, manual redirects, pagination, account mismatches, malformed/error JSON and body sanitization; mapping tests cover stable IDs, private notes, explicit unknown methods, grades, source counts and pitch facts.
- [x] Run `pnpm exec vitest run --project unit src/providers/thecrag/client.test.ts src/providers/thecrag/mapping.test.ts`; observe failure before implementation.
- [x] Implement validated official JSON requests and mapping using the [personal API contract](https://www.thecrag.com/en/article/logbookreadapi), without inventing unsupported source fields.
- [x] Run the same suites; all pass. Review mapping against canonical climbing types and source contract.
- [x] Commit and push the independently tested client/mapper.

### Task 2: Key connection, provider sync and progress

**Files:** Update `provider.ts`, `provider.test.ts`, `identity.ts`, `identity.test.ts`, `persistence.ts`, `persistence.test.ts`; create `progress.ts`, `progress.test.ts`; remove obsolete public sync parser and its tests after all consumers migrate.

**Interfaces:** Provider retains `SyncProvider`, `authSetup()` and `sync(run)`. Progress loads/saves an upstream epoch scoped to user, account and stored connection identity; persistence continues returning the number of written entries.

- [x] Replace public-sync unit coverage with failing official-key connection/full/delta tests. Assert a stored public username causes reconnect before any HTTP request; a replaced connection or full request omits `since`; unchanged connections replay the boundary; failed writes/pages preserve progress; empty deltas do not advance.
- [x] Run focused provider/progress/persistence/identity suites and observe intended failures.
- [x] Implement token validation through the official endpoint; store account identity with an explicit personal-key marker. Fetch complete page sets before writing; save progress after successful persistence and preserve additive semantics.
- [x] Run focused suites; inspect red-to-green evidence and progress failure behavior.
- [x] Commit and push provider migration, including removal of obsolete sync-only code.

### Task 3: Web/mobile and credential lifecycle

**Files:** Update `packages/web/src/components/DataSourcesAuthModals.test.tsx`, `packages/mobile/components/providers/auth-modals.test.tsx`, server sync-registration tests, `src/account-erasure/remote-snapshot.ts` and its integration tests; adjust shared auth metadata only where needed.

**Interfaces:** Existing token form consumes provider metadata `kind: access-token`, personal-key label and official instructions URL; erasure distinguishes historical public identity from owner-managed keys.

- [x] Write failing tests for concealed inputs and submitted keys on both clients; API registration advertises the key flow. Erasure blocks connected personal keys with revoke/disconnect instructions and still accepts old public identities as having no remote authorization.
- [x] Run relevant unit/mobile and real Postgres erasure suites; observe intended failures.
- [x] Update metadata/copy and erasure prerequisite without claiming remote revocation or adding new screens.
- [x] Rerun suites; verify labels, key concealment and private-note/supporter disclosure in the existing rendered flow.
- [x] Commit and push the paired-platform lifecycle change.

### Task 4: Real-database verification and documentation

**Files:** Migrate `src/providers/thecrag-sync.integration.test.ts`; update `docs/thecrag.md`, provider READMEs and incident baseline.

**Interfaces:** MSW serves official JSON while real Postgres verifies canonical persistence and operational progress. Use `pnpm test:integration` and workspace Compose tooling per [testing guide](../../testing.md#integration-dependencies).

- [x] Write failing integration cases for stable upserts/attachments, full history after reconnect, account-scoped cursors, equal epochs, private notes, incomplete pages and unchanged progress after persistence failure.
- [x] Run the focused integration command and observe failures before completing the implementation.
- [x] Finish any integration defects under TDD; remove stale public-sync fixtures and update current docs with official citations.
- [x] Run focused unit/mobile/integration suites, root and affected-client typechecks, Biome, spelling and diff checks. Record actual outcomes and any blocked prerequisites.
- [x] Request one fresh whole-branch code review; fix important findings with red-to-green regression coverage.
- [x] Commit and push final changes. Report that live recovery still requires deployment and a valid supporter key connected in Dofek.

## Execution notes

The user approved this design for implementation. Execute inline on the existing isolated `panicky-chicken` workspace; do not switch branches or deploy. Keep per-task evidence and rulings in this plan's scratch ledger, and apply one final independent branch review.

## Validation record

- Stable final unit/mobile run: 23,326 passed, 19 skipped (1,433 files passed, two skipped).
- Real Postgres/MSW provider and erasure run: 36 passed; corrected failure-trigger fixture also passes its focused rollback check.
- Root, web and mobile typechecks; sandbox lint; configured spelling (3,080 files); diff checks pass.
- Concealed key form inspected in Firefox via its specific Storybook story.
- One independent whole-branch review completed. Three important findings fixed with red-to-green coverage: shared HTTP error-body privacy, omitted-date preservation, and actionable 400/403 connection guidance. No deferred findings.
- No production deployment or authenticated live sync was performed.
