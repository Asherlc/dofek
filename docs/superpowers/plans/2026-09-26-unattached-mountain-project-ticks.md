# Unattached Mountain Project Ticks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store Mountain Project ticks without synthetic activities and let users attach same-day ticks individually to real climbing activities.

**Architecture:** Extend the existing `fitness.climbing_entry` row to represent an owned, source-attributed tick with an optional activity association and one normalized date only while unattached. The provider sync owns tick upsert and absence reconciliation; a server repository and tRPC procedures own exact-day suggestions and attachment; web and mobile render the shared contract. Climbing grade and volume summaries continue to count unattached ticks by their standalone date, while session summaries remain activity-based.

**Tech Stack:** TypeScript, Drizzle ORM, PostgreSQL/TimescaleDB, tRPC, React, React Native, Vitest.

**Spec:** [`docs/superpowers/specs/2026-09-26-unattached-mountain-project-ticks-design.md`](../specs/2026-09-26-unattached-mountain-project-ticks-design.md)

## Global Constraints

- Store each Mountain Project tick as one canonical `fitness.climbing_entry` row, without creating a synthetic activity for it.
- Allow a tick to exist before it is associated with a workout.
- On a climbing activity detail page, suggest only unattached Mountain Project ticks whose exported date is the same as the activity's displayed calendar day.
- Let the user attach each tick individually to the selected activity.
- Preserve tick identity, ownership, and any user-selected association across later Mountain Project syncs.
- Keep unattached ticks in climb and grade progression summaries without treating them as activities or sessions.
- Provide the same behavior on web and mobile through the shared server API.
- Automatically selecting or attaching a tick to a same-day activity.
- An unmatched-ticks inbox, dismissal state, or suggestion-ranking system.
- Linking ticks to non-climbing activities or to activities on another day.
- Creating a second table that copies climbing-entry data or stores a separate
  suggestion/link record.
- Deleting raw ticks when Mountain Project stops returning them.

## Review Focus

- A Mountain Project date near UTC midnight must match the activity's displayed user-timezone date exactly; test adjacent dates on both sides.
- A same-day tick must remain unattached until the user selects an activity, even when only one candidate activity exists.
- A re-sync must preserve a user's attachment and keep `unattached_date` null; a removed tick must become absent without deleting raw data.
- A user must not attach another user's tick, a tick already attached elsewhere, a non-Mountain-Project tick, or a tick to a non-climbing/different-day activity.
- Unattached ticks must count in grade and volume summaries without creating session counts or durations.

---

## File Structure

- `src/db/schema/activity.ts` owns the climbing-entry table definition and its
  database-level association/date invariants.
- `drizzle/0125_unattached_mountain_project_ticks.sql` migrates existing tick
  ownership, provider identity, date, attachment, and wrapper visibility;
  `drizzle/meta/_journal.json` and generated schema diagrams track that schema.
- `src/providers/mountain-project.ts` parses and syncs one provider tick per
  climbing-entry row; its unit and integration tests pin identity and sync
  lifecycle behavior.
- `packages/server/src/repositories/mountain-project-tick-repository.ts` owns
  user-scoped same-day suggestions and atomic attachment. The climbing router
  exposes those operations through the shared API.
- `packages/server/src/repositories/climbing-repository.ts` owns simple grade
  and volume summaries; session summaries and activity detail continue to
  require a real associated activity.
- `packages/web/src/pages/ActivityDetailPage.tsx` and
  `packages/mobile/app/activity/[id].tsx` render the same suggestions and
  per-tick action. Route tests stay in each platform's established location.
- `docs/README.md` makes the Mountain Project provider guide discoverable.
- `docs/schema.md` and `docs/mountain-project.md` describe the resulting schema
  and provider behavior for humans.

## Task 1: Model standalone climbing entries and migrate existing ticks

**Files:**

- Modify: `src/db/schema/activity.ts`
- Create: `drizzle/0125_unattached_mountain_project_ticks.sql`
- Modify: `drizzle/meta/_journal.json`
- Modify: `docs/schema.dbml`
- Modify: `docs/schema.puml`
- Modify: `src/db/drizzle-schema.test.ts`
- Create: `src/db/unattached-climbing-entry.integration.test.ts`
- Create: `src/db/mountain-project-tick-migration.integration.test.ts`

**Interfaces:**

- Produces `climbingEntry.userId: uuid`, `climbingEntry.providerId: text`,
  `climbingEntry.activityId: uuid | null`,
  `climbingEntry.unattachedDate: date | null`, and
  `climbingEntry.providerAbsentAt: timestamp | null`.
- Produces the row invariant: `activity_id IS NULL` exactly when
  `unattached_date IS NOT NULL`; when attached, the activity and entry belong
  to the same user.
- Produces source identity unique by `(user_id, provider_id, external_id)` for
  rows with an external ID.

- [ ] **Step 1: Write standalone-entry database tests first**

In `src/db/unattached-climbing-entry.integration.test.ts`, use the current
`setupTestDatabase()` schema and raw SQL to insert an unattached Mountain
Project tick. Assert it has an owner/provider, an exported date, no activity,
and its raw payload. Add checks that both association/date being null and both
being populated violate the row invariant, and that an attached entry cannot
point to another user's activity.

- [ ] **Step 2: Run the standalone-entry integration test and confirm it fails**

Run: `pnpm test:integration -- src/db/unattached-climbing-entry.integration.test.ts`

Expected: FAIL because the current table lacks the standalone-entry columns
and constraints.

- [ ] **Step 3: Add schema fields and generate migration `0125`**

Add required owner and provider references, nullable `activity_id`, nullable
`unattached_date`, and nullable provider absence state. Add a composite ownership
constraint for attached entries, the exclusive link/date check, an index for
active same-day unattached lookup, and the source-identity unique index. Add a
composite unique key to `fitness.activity(user_id, id)` if the current schema
does not already provide it. Preserve the current linked-entry shape for other
climbing providers. Run `pnpm generate` to create the initial migration,
journal entry, and diagrams.

- [ ] **Step 4: Add historical-row migration coverage before the backfill**

In `mountain-project-tick-migration.integration.test.ts`, follow
`src/db/stable-activity-groups-migration.integration.test.ts`: apply the schema
through migration `0124`, seed historical Mountain Project wrapper activity and
tick rows plus a non-Mountain-Project climbing row, then apply migration `0125`.
Assert the Mountain Project rows retain their payload, gain owner/provider
identity and exported date, detach from the wrapper, and the wrapper is retired
from normal visibility. Assert the non-Mountain-Project row remains attached
and no raw tick is deleted.

- [ ] **Step 5: Run the migration test and confirm the data assertions fail**

Run: `pnpm test:integration -- src/db/mountain-project-tick-migration.integration.test.ts`

Expected: FAIL because the generated schema migration does not yet backfill,
detach, and retire the historical Mountain Project rows.

- [ ] **Step 6: Complete the data migration and run both integration suites**

Edit generated migration `0125` to backfill owner and provider from each parent
activity for every existing climbing entry. Add new columns nullable first,
then backfill before enforcing non-null owner/provider references. For Mountain
Project rows, derive the exported day from the existing UTC-midnight parent,
copy provider absence state, detach the tick, and retire the synthetic parent
activities from normal visibility without deleting tick data. Enforce the
row/date check, same-owner activity relationship, indexes, and nullability only
after backfill. Then run:

`pnpm test:integration -- src/db/unattached-climbing-entry.integration.test.ts src/db/mountain-project-tick-migration.integration.test.ts`

Expected: PASS; standalone constraints hold, historical Mountain Project rows
are retained and transformed, and unrelated climbing rows keep their links.

- [ ] **Step 7: Run schema checks**

Run: `pnpm test -- src/db/drizzle-schema.test.ts`

Expected: PASS with the new columns, nullability, and constraints represented
in the Drizzle schema.

- [ ] **Step 8: Commit and push the data-model task**

Commit the schema, migration, journal, generated diagrams, and migration tests
with message `Model unattached climbing entries`; push the current branch.

## Task 2: Sync Mountain Project ticks as independent records

**Files:**

- Modify: `src/providers/mountain-project.ts`
- Modify: `src/providers/mountain-project.test.ts`
- Modify: `src/providers/mountain-project-sync.integration.test.ts`

**Interfaces:**

- Consumes the Task 1 `climbingEntry` fields and uniqueness invariant.
- Produces idempotent per-tick upsert behavior keyed by
  `(user_id, provider_id, external_id)`.
- Provider upsert may refresh source-owned tick fields and raw payload, but
  must preserve `activity_id` and keep `unattached_date` null for an attached
  tick.
- Produces per-tick full-list absence reconciliation; an ambiguous empty export
  and failed export do not mass-retire records.

- [ ] **Step 1: Add failing provider unit tests**

In `src/providers/mountain-project.test.ts`, add cases asserting that one
climbing-entry row is produced per supported tick with owner, provider ID,
`unattachedDate`, and the existing stable external ID, with no calls to
`upsertProviderActivity`. Add an upsert-conflict case that preserves an existing
activity attachment and null standalone date. Add cases for absent/restored
tick identities, ambiguous empty export, unsupported-only export, and request
failure.

- [ ] **Step 2: Run the provider unit suite and confirm it fails**

Run: `pnpm test -- src/providers/mountain-project.test.ts`

Expected: FAIL because the importer still creates grouped activity wrappers and
does not persist standalone ticks.

- [ ] **Step 3: Implement per-tick upsert and reconciliation**

Refactor `MountainProjectProvider.sync()` to write each parsed supported tick
directly to `fitness.climbing_entry`. Remove wrapper-activity upserts and
activity-list reconciliation from this provider path. On conflict, update only
provider-owned tick fields and presence state; never reset `activity_id` or
populate `unattached_date` on an attached row. Mark absent tick identities and
restore identities that reappear, preserving the existing empty-list safety
behavior.

- [ ] **Step 4: Run provider unit tests**

Run: `pnpm test -- src/providers/mountain-project.test.ts`

Expected: PASS, including the accepted-attachment-preserved-on-resync case.

- [ ] **Step 5: Add and run provider database integration coverage**

In `src/providers/mountain-project-sync.integration.test.ts`, assert repeat sync
does not duplicate tick rows, does not create Mountain Project activity rows,
preserves a manually attached tick, retires a source-absent tick without
deleting it, restores a returning tick, and retains the current empty-export
safety behavior.

Run: `pnpm test:integration -- src/providers/mountain-project-sync.integration.test.ts`

Expected: PASS against PostgreSQL.

- [ ] **Step 6: Commit and push the provider task**

Commit the provider implementation and tests with message
`Sync Mountain Project ticks without activity wrappers`; push the current
branch.

## Task 3: Add server-side suggestions and attachment

**Files:**

- Create: `packages/server/src/repositories/mountain-project-tick-repository.ts`
- Create: `packages/server/src/repositories/mountain-project-tick-repository.test.ts`
- Create: `packages/server/src/repositories/mountain-project-tick-repository.integration.test.ts`
- Modify: `packages/server/src/routers/climbing.ts`
- Modify: `packages/server/src/routers/climbing.test.ts`
- Modify: `packages/server/src/routers/climbing.integration.test.ts`

**Interfaces:**

- Produces `MountainProjectTickRepository.getSuggestions(activityId: string)`
  returning active unattached Mountain Project entries whose `unattached_date`
  equals the resolved activity's displayed date.
- Produces `MountainProjectTickRepository.attachTick(input: { tickId: string;
  activityId: string }): Promise<void>`; activity ID is the canonical activity
  detail ID supplied by the client and resolved by `ActivityRepository`.
- Produces `climbing.unattachedMountainProjectTicks({ activityId })` and
  `climbing.attachMountainProjectTick({ activityId, tickId })` procedures.

- [ ] **Step 1: Add failing repository unit tests**

In `mountain-project-tick-repository.test.ts`, assert exact-day selection,
provider/owner/absence/unattached filters, and the conditional association
update. Include a UTC-midnight fixture where the activity's displayed date is
the next calendar day in `America/Los_Angeles` and assert that only that exact
date matches.

- [ ] **Step 2: Run the repository unit suite and confirm it fails**

Run: `pnpm test -- packages/server/src/repositories/mountain-project-tick-repository.test.ts`

Expected: FAIL because the repository does not exist.

- [ ] **Step 3: Implement user-scoped same-day query and attach transaction**

Resolve the canonical activity through `ActivityRepository`. Use the activity
detail's server-computed local date for suggestion filtering. The attach
transaction must revalidate user, source, active/unattached state, climbing
type, and exact displayed-day equality, then set `activity_id` and clear
`unattached_date` in one conditional update. Return a specific conflict when a
concurrent attach wins.

- [ ] **Step 4: Run repository unit tests**

Run: `pnpm test -- packages/server/src/repositories/mountain-project-tick-repository.test.ts`

Expected: PASS, including timezone boundary and stale/conflicting attachment
cases.

- [ ] **Step 5: Add tRPC procedures and real-database tests**

Add the two procedures to `climbing.ts`, with Zod input/output schemas,
user-scoped access, actionable `TRPCError` messages, and targeted cache
invalidation after attach. Test visible group-ID resolution, cross-user
rejection, wrong activity type, adjacent-day rejection, already-attached
conflict, and successful single-tick attachment in the router integration
suite.

- [ ] **Step 6: Run the server unit and integration tests**

Run: `pnpm test -- packages/server/src/routers/climbing.test.ts`

Expected: PASS.

Run: `pnpm test:integration -- packages/server/src/repositories/mountain-project-tick-repository.integration.test.ts packages/server/src/routers/climbing.integration.test.ts`

Expected: PASS against PostgreSQL.

- [ ] **Step 7: Commit and push the server matching task**

Commit repository, router, and tests with message
`Suggest and attach same-day Mountain Project ticks`; push the current branch.

## Task 4: Keep unattached ticks in climb and grade summaries

**Files:**

- Modify: `packages/server/src/repositories/climbing-repository.ts`
- Modify: `packages/server/src/repositories/climbing-repository.test.ts`
- Create: `packages/server/src/repositories/climbing-repository.integration.test.ts`

**Interfaces:**

- `getGradeProgression(days)` and `getVolumeByGrade(days)` include active
  unattached ticks by `unattached_date` in the configured user timezone range.
- `getSessionSummaries(days)` and `getActivityEntries(activityId)` remain based
  on attached entries and actual activity rows.

- [ ] **Step 1: Add failing summary tests**

In `climbing-repository.test.ts`, add SQL/repository cases for detached ticks
appearing in grade and volume summaries, absent ticks being excluded, and
session summaries remaining tied to actual activities. Include an attached
entry fixture and assert it appears once through its activity rather than as an
unattached contribution.

- [ ] **Step 2: Run the summary unit tests and confirm they fail**

Run: `pnpm test -- packages/server/src/repositories/climbing-repository.test.ts`

Expected: FAIL because current summary queries only join entries through
`fitness.v_activity` members.

- [ ] **Step 3: Include standalone entries in grade and volume query ranges**

Update only `getGradeProgression` and `getVolumeByGrade` to combine attached
activity entries and active unattached ticks using the shared user-timezone date
window. Leave session count, duration, and activity-detail queries activity-
based.

- [ ] **Step 4: Run climbing repository unit tests**

Run: `pnpm test -- packages/server/src/repositories/climbing-repository.test.ts`

Expected: PASS with detached entries included only in tick-based summaries.

- [ ] **Step 5: Verify query behavior against PostgreSQL**

Seed one attached send, one unattached Mountain Project send, and one absent
unattached tick. Assert the grade/volume totals include the two active sends,
while session summaries contain only the real attached activity.

Run: `pnpm test:integration -- packages/server/src/repositories/climbing-repository.integration.test.ts`

Expected: PASS against PostgreSQL.

- [ ] **Step 6: Commit and push the summary task**

Commit the repository and tests with message
`Include unattached ticks in climbing summaries`; push the current branch.

## Task 5: Render suggestions in web and mobile activity details

**Files:**

- Modify: `packages/web/src/pages/ActivityDetailPage.tsx`
- Modify: `packages/web/src/pages/ActivityDetailPage.test.tsx`
- Modify: `packages/mobile/app/activity/[id].tsx`
- Modify: `packages/mobile/app-tests/activity/[id].test.tsx`

**Interfaces:**

- Both clients consume the server procedure shapes from Task 3; clients do not
  determine day matches or calculate climb metrics.
- Each returned tick has an independent attach action targeting the open
  activity.

- [ ] **Step 1: Add failing web and mobile route tests**

In web and mobile activity detail tests, assert that a climbing activity
renders its same-day unmatched Mountain Project ticks and one attach control
per tick; different-day activities render none. Assert that clicking one
control submits only that tick and refreshes climbing-entry and suggestion
queries. Assert loading, actionable error, and empty states separately.

- [ ] **Step 2: Run both route test suites and confirm they fail**

Run: `pnpm test -- packages/web/src/pages/ActivityDetailPage.test.tsx 'packages/mobile/app-tests/activity/[id].test.tsx'`

Expected: FAIL because neither detail screen queries or attaches unmatched
ticks.

- [ ] **Step 3: Add suggestion query and per-tick mutation to web**

In `ActivityDetailPage.tsx`, enable the suggestions query only for climbing
activities. Render a focused section beside the current climb breakdown, and
wire one pending/error state per tick to the attach mutation. Invalidate only
the activity-entry and suggestion queries after success.

- [ ] **Step 4: Run the web detail tests**

Run: `pnpm test -- packages/web/src/pages/ActivityDetailPage.test.tsx`

Expected: PASS for exact displayed-day suggestions and individual attachment.

- [ ] **Step 5: Add matching behavior to mobile**

In `packages/mobile/app/activity/[id].tsx`, render the same server-returned
tick fields and per-tick attach control. Use the existing explicit loading,
error, and empty-state patterns and invalidate only affected climbing queries
on success.

- [ ] **Step 6: Run the mobile detail tests**

Run: `pnpm test -- 'packages/mobile/app-tests/activity/[id].test.tsx'`

Expected: PASS with the same suggestion and attachment behavior as web.

- [ ] **Step 7: Commit and push the client task**

Commit both client changes and route tests with message
`Show same-day climbing tick suggestions`; push the current branch.

## Task 6: Update provider and schema documentation; run final checks

**Files:**

- Modify: `docs/mountain-project.md`
- Modify: `docs/schema.md`
- Modify: `docs/README.md`
- Modify: generated `docs/schema.dbml` and `docs/schema.puml` if not already
  updated in Task 1.

- [ ] **Step 1: Update human-facing data and provider docs**

Describe that Mountain Project ticks are standalone climbing entries, that
their normalized date exists only while unmatched, how exact-day suggestions
use the activity's displayed date, and how attaching a tick makes the activity
the source of its day. Link to the observed provider export contract and the
design spec; do not describe the unsupported endpoint as an official API.

- [ ] **Step 2: Check documentation links and diff formatting**

Run: `git diff --check`

Expected: PASS with valid relative links to the provider guide and current
schema documentation.

- [ ] **Step 3: Run focused feature validation**

Run the provider unit test, migration/provider/server integration tests, both
climbing repository suites, router tests, and web/mobile detail tests listed in
Tasks 1–5. Then run `pnpm typecheck` and `pnpm lint:sandbox`.

Expected: every listed command passes. If Docker cannot start the integration
dependencies, preserve all other workspaces' Docker resources and report the
exact blocked command.

- [ ] **Step 4: Review full diff and push final integration commit**

Verify both clients, migration, provider sync, and all climbing queries listed
in this plan implement the approved spec. Commit documentation and any final
integration corrections with message `Document unattached Mountain Project
ticks`; push the current branch.

---

## Review Checkpoints

1. Review after Task 1: schema invariants and historical-row migration.
2. Review after Task 2: tick identity, provider absence, and resync behavior.
3. Review after Tasks 3–4: server-side day/ownership rules and summary effects.
4. Review after Task 5: web/mobile parity and user-visible states.
5. Final whole-branch review after Task 6.
