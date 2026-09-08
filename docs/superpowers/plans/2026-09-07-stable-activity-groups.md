# Stable Activity Groups Implementation Plan

**Goal:** Make activity identity persistent and hydrate grouped activities from every member so representative changes cannot hide exercise, sensor, location, elevation, or classification data.

**Architecture:** Persist a first-class PostgreSQL activity group and canonical membership on each raw activity. Reconcile overlap components transactionally before publishing the activity canonical-commit watermark. Project that stable group ID through ClickHouse, select representatives with a shared payload-first rank contract, and hydrate each payload family independently of the display representative.

**Tech Stack:** TypeScript, Drizzle ORM, PostgreSQL, ClickHouse/dbt, Zod, Vitest, fast-check.

**Spec:** `docs/superpowers/specs/2026-09-07-stable-activity-groups-design.md`

## Global constraints

- Follow red-green-refactor for every behavior change. A passing first test means the proposed test does not reproduce a defect and must not be used to justify a production change.
- Keep raw provider activities and raw sensor data intact. Group membership is structural metadata; no provider row or sample is discarded.
- Never copy sensor-derived facts into PostgreSQL. ClickHouse ranking owns sensor presence; PostgreSQL ranking owns relational structured payload.
- All activity APIs resolve identity once and pass the stable group ID downstream.
- Use `fitness.v_activity` and deduplicated ClickHouse models for reads; never read raw sensor streams to make an API metric available.
- Update the canonical view file and add a forward migration together.
- Every commit in this plan is pushed to `origin/fix/activity-representative-selection` immediately.

---

## Task 1: Define and test the domain algorithms

**Files:**

- Create: `src/domain/activity-grouping.ts`
- Create: `src/domain/activity-grouping.test.ts`
- Create: `src/domain/activity-representative.ts`
- Create: `src/domain/activity-representative.test.ts`

**Produces:** Pure connected-component reconciliation decisions and a pure representative rank tuple.

- [ ] Write failing representative tests covering:
  - a strength member with complete working sets outranking an empty WHOOP mirror;
  - a sensor-bearing member outranking a metadata-only member;
  - `cycling` outranking `cardio`;
  - `providerType: "commuting"` outranking an unrefined cycling member;
  - provider priority and UUID being only final tie-breakers;
  - every permutation of the same members selecting the same representative.
- [ ] Write failing grouping tests covering:
  - a new singleton receives its own group;
  - adding an overlapping member preserves the existing group ID;
  - merging two existing groups retains the oldest group and emits an alias for the loser;
  - splitting retains the ID on the component containing the oldest member;
  - input permutation does not change components or decisions.
- [ ] Run `pnpm vitest run src/domain/activity-grouping.test.ts src/domain/activity-representative.test.ts` and confirm missing-module failures.
- [ ] Implement only the pure algorithms and strongly typed inputs/outputs.
- [ ] Run the focused tests and mutation-test the two modules.
- [ ] Commit and push: `Add stable activity grouping domain model`.

## Task 2: Persist group identity and backfill without changing visible IDs

**Files:**

- Modify: `src/db/schema/activity.ts`
- Modify: `src/db/schema/index.ts` if required by the schema barrel
- Create: `drizzle/0116_stable_activity_groups.sql`
- Modify: `drizzle/meta/_journal.json`
- Create: `src/db/stable-activity-groups-migration.integration.test.ts`

**Produces:** `fitness.activity_group`, `fitness.activity_group_alias`, non-null `fitness.activity.group_id`, and database-enforced singleton creation.

- [ ] Write a real-PostgreSQL migration test that creates overlapping activity rows under the pre-migration schema and captures their current `fitness.v_activity.id` values.
- [ ] Assert initially that the new tables/column do not exist.
- [ ] Apply only migration `0110` in the test and assert:
  - current visible group IDs are unchanged;
  - every activity has a non-null group ID owned by the same user;
  - every group ID has a group row;
  - direct activity insertion creates a valid singleton group;
  - cross-user membership and self-aliases fail by constraint;
  - migration execution is atomic.
- [ ] Run the focused integration test and verify it fails before the migration exists.
- [ ] Add Drizzle definitions for the two tables, the `groupId` member field, indexes, ownership constraints, and alias reason constraint.
- [ ] Implement the migration in this order:
  1. create group and alias tables;
  2. add nullable `activity.group_id`;
  3. create singleton group rows for every activity;
  4. use the pre-existing `v_activity` membership arrays to assign each active component its current public ID;
  5. assign remaining historical/tombstoned rows to singleton IDs;
  6. enforce non-null, same-user foreign key, and indexes;
  7. install the database insertion function/trigger that creates a singleton group for new rows.
- [ ] Run `pnpm test:integration -- src/db/stable-activity-groups-migration.integration.test.ts`.
- [ ] Run schema/type checks relevant to Drizzle.
- [ ] Commit and push: `Persist stable activity group identity`.

## Task 3: Reconcile membership transactionally before CDC watermarks

**Files:**

- Create: `src/db/activity-group-reconciliation.ts`
- Create: `src/db/activity-group-reconciliation.test.ts`
- Create: `src/db/activity-group-reconciliation.integration.test.ts`
- Modify: `src/processing/processing-event-store.ts`
- Modify: `src/processing/processing-event-store.test.ts`
- Modify: `src/jobs/process-sync-job.test.ts`
- Modify: `src/jobs/process-import-job.test.ts`

**Produces:** `reconcileActivityGroups(transaction, userId)` and activity canonical commits that cannot precede grouping.

- [ ] Write unit tests for translating stored activities and existing group metadata into the Task 1 decisions.
- [ ] Write integration tests that seed separate provider activities, invoke reconciliation, then change provider priority and rerun it. Assert the group ID remains fixed.
- [ ] Add integration cases for late member addition, merge alias creation, split ownership, tombstone/restore, and concurrent reconciliation attempts for one user.
- [ ] Add a processing-event-store test proving an activity relational commit:
  - obtains the operation's user ID;
  - reconciles inside the same transaction;
  - reads `pg_current_wal_lsn()` only afterward;
  - does not create a canonical commit/outbox row when reconciliation throws.
- [ ] Run focused unit/integration tests and confirm failures.
- [ ] Implement the repository using parameterized SQL, `pg_advisory_xact_lock`, and the pure domain algorithms. Resolve an alias target before inserting another alias so chains/cycles are not created.
- [ ] Invoke reconciliation only when `datasetKeys` contains `activity`; leave unrelated canonical commits unchanged.
- [ ] Report unexpected failures to Sentry at the existing worker boundary and rethrow; do not warn and continue.
- [ ] Run focused tests plus `process-sync-job` and `process-import-job` tests.
- [ ] Commit and push: `Reconcile activity groups before analytics`.

## Task 4: Make the PostgreSQL canonical view stable and payload-first

**Files:**

- Modify: `drizzle/_views/01_v_activity.sql`
- Create: `drizzle/0117_v_activity_stable_groups.sql`
- Modify: `drizzle/meta/_journal.json`
- Modify: `packages/server/src/routers/activity-dedup.integration.test.ts`
- Modify: `src/db/activity-overlap-plan.integration.test.ts`

**Produces:** A canonical row keyed by `activity_group.id`, with representative member ID exposed separately.

- [ ] Add failing database tests asserting:
  - `v_activity.id` equals persisted `group_id` before and after provider-priority changes;
  - `primary_activity_id` changes when representative evidence changes without changing `id`;
  - a member with strength sets outranks a strength mirror without sets;
  - a specific type outranks `cardio`/`other`;
  - a provider-type refinement outranks an unrefined peer;
  - provider priority decides only otherwise-equal members;
  - member/source arrays remain complete.
- [ ] Run the focused integration tests and confirm the current view fails the identity and payload assertions.
- [ ] Rewrite grouping CTEs to use `activity.group_id`; remove recursive identity derivation from the view.
- [ ] Add relational payload scores from `strength_set` and apply the shared lexicographic order.
- [ ] Keep bounds, timezone evidence, raw-key merge, absent-source handling, and provenance union independent of the representative.
- [ ] Copy the canonical view into migration `0111` with the standard source-of-truth header.
- [ ] Run the focused integration tests and `git diff --check`.
- [ ] Commit and push: `Make Postgres activity projection representative independent`.

## Task 5: Project stable groups and payload-first sensor ranking through ClickHouse

**Files:**

- Modify: `analytics/models/read_models/activity_source_records.sql`
- Modify: `analytics/models/read_models/deduped_activities.sql`
- Modify: `analytics/models/read_models/deduped_activity_members.sql`
- Modify or retire: `analytics/models/read_models/activity_duplicate_groups.sql`
- Retire if unused: `analytics/models/read_models/activity_duplicate_matches.sql`
- Modify: `analytics/models/read_models/read_model_microbatch.sql.test.ts`
- Modify: `analytics/models/read_models/activity_duplicate_groups.integration.test.ts`
- Modify: `analytics/models/read_models/activity_duplicate_matches.integration.test.ts`
- Create: `src/db/clickhouse-migrations/0079_stable_activity_group_id.ts`
- Create: `src/db/clickhouse-migrations/0079_stable_activity_group_id.test.ts`
- Modify: `src/db/clickhouse-migrations/registry.ts`

**Produces:** ClickHouse activity rows keyed by the persisted PostgreSQL group, not a recomputed connected-component label.

- [ ] Write failing SQL-policy and executable ClickHouse tests asserting:
  - `activity_source_records` carries `group_id`;
  - `deduped_activities.activity_id` is that group ID;
  - sensor presence/sample richness is the first representative sort key;
  - specific type, provider refinement, priority, and UUID follow in order;
  - changing the winning member does not tombstone/recreate the canonical group key;
  - `member_activity_ids` remains complete.
- [ ] Add the ClickHouse source-mirror column migration and registry tests.
- [ ] Replace ClickHouse-owned group discovery with the persisted membership projection. Remove obsolete models only after all references are gone; add a migration drop for obsolete read-model tables if they are retired.
- [ ] Retain scoped-refresh dirty-key behavior for group IDs and member IDs.
- [ ] Run focused SQL tests and `pnpm test:integration` for executable duplicate/group models.
- [ ] Commit and push: `Use stable activity groups in ClickHouse`.

## Task 6: Make sensor, GPS, and elevation hydration a group union

**Files:**

- Modify: `analytics/models/read_models/activity_sensor_sample.sql`
- Modify: `analytics/models/read_models/activity_sensor_summary_rows.sql`
- Modify: `analytics/models/read_models/activity_location_sample.sql`
- Modify: `analytics/models/read_models/activity_location_summary_rows.sql`
- Modify: `analytics/models/read_models/activity_summary_rows.sql`
- Modify: relevant colocated SQL tests
- Create or modify: executable ClickHouse integration tests for activity summary hydration

**Produces:** One stable group summary populated from every member's deduplicated samples and location evidence.

- [ ] Add a fixture with disjoint payloads: metadata-only Peloton cardio, WHOOP cycling/commuting plus heart rate, and a third member with GPS/elevation.
- [ ] Assert the group summary has `canonical_type=cycling`, commute refinement, non-null heart rate, GPS, and elevation for every possible representative choice.
- [ ] Add a property/permutation test that compares the set of populated output fields across representative permutations.
- [ ] Run the executable ClickHouse test and confirm failure on current summary/member compatibility behavior.
- [ ] Key all sample and summary joins on persisted group membership. Continue reading `analytics.deduped_sensor`; never read raw `ingest.metric_stream` for served metrics.
- [ ] Preserve existing source-priority/location deduplication so overlapping providers do not double-count distance.
- [ ] Ensure incremental dirty keys invalidate both old aliases/member IDs and the stable group key.
- [ ] Run focused ClickHouse tests.
- [ ] Commit and push: `Union activity sensor payloads across group members`.

## Task 7: Resolve IDs explicitly and remove representative-compatible summary selection

**Files:**

- Modify: `packages/server/src/models/activity.ts`
- Modify: `packages/server/src/models/activity.test.ts`
- Modify: `packages/server/src/repositories/activity-repository.ts`
- Modify: `packages/server/src/repositories/activity-repository.test.ts`
- Modify: `packages/server/src/repositories/activity-repository.integration.test.ts` if present, otherwise add a focused integration test beside it
- Modify: `packages/server/src/mcp/tool-output.ts`
- Modify: `packages/server/src/mcp/route.test.ts`

**Produces:** Stable group/member/alias resolution and `resolvedFrom` / `resolved_from` response fields.

- [ ] Add failing repository tests for direct group lookup, member lookup, merge-alias lookup, cross-user denial, and not found.
- [ ] Assert `resolved_from` is null/absent for a direct group request and equals the requested UUID for member/alias resolution.
- [ ] Add a failing hydration test in which only the stable group summary is populated and the PostgreSQL representative has no sensor data.
- [ ] Add a property test: for summaries containing disjoint non-null fields, hydration produces the same populated field set regardless of representative metadata.
- [ ] Run focused tests and confirm current `ANY(member_activity_ids)` silently substitutes and `selectCompatibleActivitySummary` discards fields.
- [ ] Introduce a single resolution query over group, member, and alias identities. Return the resolution kind internally and attach `resolved_from` when IDs differ.
- [ ] Query ClickHouse summaries by stable group ID only. Delete `selectCompatibleActivitySummary` and member-summary filtering.
- [ ] Add the camel-case domain field and snake-case MCP schema field without changing unrelated response names.
- [ ] Run focused model, repository, route, and MCP schema tests.
- [ ] Commit and push: `Expose explicit stable activity ID resolution`.

## Task 8: Union structured activity payloads without index collisions

**Files:**

- Modify: `packages/server/src/repositories/strength-repository.ts`
- Modify: `packages/server/src/repositories/strength-repository.test.ts`
- Modify: `packages/server/src/repositories/climbing-repository.ts` and its colocated test if it has the same unresolved-ID assumption
- Modify: `packages/server/src/repositories/climbing-training-log-repository.ts` and its colocated test if needed
- Modify: `packages/server/src/routers/activity.ts`
- Modify: `packages/server/src/routers/activity.test.ts`
- Modify: `packages/server/src/mcp/activity-details-tool.ts`
- Modify: `packages/server/src/mcp/activity-details-tool.test.ts` if present, otherwise `packages/server/src/mcp/route.test.ts`

**Produces:** Structured collections hydrated from all group members with source-aware deduplication.

- [ ] Add failing strength tests with two members that both use `exercise_index=0` but contain different exercises. Assert neither is collapsed.
- [ ] Add failing tests with mirrored equivalent sets and disjoint sets. Assert exact equivalents appear once while disjoint payload remains.
- [ ] Add failing router/MCP tests requesting a non-representative Strong member ID and expecting non-empty exercises from the resolved group.
- [ ] Include `member_activity_id` in strength query rows and group by normalized exercise identity plus equipment, never bare provider-local index.
- [ ] Deduplicate sets by the approved signature `(setType, setIndex, weightKg, reps, durationSeconds)` and prefer completeness before source priority.
- [ ] Pass `activity.id`—the resolved stable group ID—to strength, climbing, and finger-loading repositories from both tRPC and MCP.
- [ ] Run focused repository/router/MCP tests.
- [ ] Commit and push: `Union structured activity details across members`.

## Task 9: Pin Strong machine rows and repair verified metadata aliases

**Files:**

- Modify: `src/providers/strong-csv.test.ts`
- Modify only if a failing reproduction identifies it: `src/providers/strong-csv.ts`
- Modify: `src/exercise-metadata-overrides.json`
- Modify: `src/exercise-metadata.test.ts`
- Modify: `docs/exercise-metadata.md`

**Produces:** Exact regression coverage for the supplied machine rows and verified catalogue alias enrichment.

- [ ] Build an inline minimal CSV fixture from the supplied header and September 3 rows: Deadlift, Seated Leg Curl `140 × 11/8/7`, and Leg Extension `140 × 8`.
- [ ] Assert parsed/persisted values are `63.503 kg × 11/8/7` (within existing rounding conventions), never `4.99/3.629/3.175 kg × 140`.
- [ ] If this test passes immediately, record that ingestion is already correct and do not alter parser production code. Use the Task 8 provenance test to locate any hydration corruption.
- [ ] Test each of the 18 uploaded-name misses through `lookupExerciseMuscleGroups`. Add overrides only for unambiguous bundled-catalogue aliases, keeping ambiguous/absent names null.
- [ ] Document the final matched and unresolved lists and the reason class: alias mismatch versus absent catalogue entry.
- [ ] Run `pnpm vitest run src/providers/strong-csv.test.ts src/exercise-metadata.test.ts packages/server/src/repositories/strength-repository.test.ts`.
- [ ] Commit and push: `Cover Strong machine rows and exercise aliases`.

## Task 10: End-to-end regression fixtures and operational record

**Files:**

- Modify: `packages/server/src/mcp/route.test.ts`
- Modify: `packages/server/src/routers/activity-dedup.integration.test.ts`
- Add or modify: an end-to-end activity details test using real PostgreSQL and ClickHouse fixtures
- Modify: `docs/production-incident-baseline.md`
- Modify: `docs/activity-data-integrity-repair-runbook.md`

**Produces:** Pinned response-schema fixtures for the reported strength/cycling scenarios and an operator-safe refresh/remediation procedure.

- [ ] Seed fixtures equivalent to:
  - September 3 Apple Health + Strong + WHOOP strength group;
  - September 1 strength group;
  - two WHOOP cycling/commuting + Peloton cardio groups.
- [ ] Fetch details, change representative priority/evidence, reconcile and refresh, then re-fetch the original IDs.
- [ ] Assert stable ID, explicit `resolved_from` for member/alias requests, expected deadlift sets/rest rows, non-empty September 1 exercises, cycling/commuting classification, non-null heart rate, and unchanged populated-field sets.
- [ ] Parse the final MCP payload through `activityDetailsOutputSchema` to pin current field names.
- [ ] Append the incident baseline with symptoms, evidence, root causes, fix, remaining risk, and remediation status.
- [ ] Update the repair runbook with group refresh order and the rule that Strong is re-imported only when stored source rows—not hydrated output—are proven corrupt.
- [ ] Run the focused end-to-end/integration tests.
- [ ] Commit and push: `Add activity identity regression coverage`.

## Task 11: Full verification and review

- [ ] Run formatting/linting and type checking with the repository's documented commands.
- [ ] Run `pnpm test:changed`.
- [ ] Run `pnpm test:changed:all` for PostgreSQL/ClickHouse behavior.
- [ ] Run targeted Stryker mutation tests for the grouping, representative, resolution, and strength-union modules.
- [ ] Verify the migration journal, canonical view/migration parity, ClickHouse migration registry, and `git diff --check`.
- [ ] Inspect `git status` and confirm only intended files changed.
- [ ] Use the code-review skill/workflow for an independent requirements and quality review; resolve all valid findings.
- [ ] Push the final commit and report exact verification results, any unavailable production-only checks, and the metadata miss list.

## Expected durable invariants

- A representative change never changes `activity.id`.
- A requested member or historical group ID is never silently substituted.
- The set of populated payload fields is independent of representative selection.
- Provider-local collection indexes are never treated as group-global identities.
- PostgreSQL owns structural group identity; ClickHouse owns sensor evidence and derived summaries.
- Raw provider records and deduplicated sensor samples remain the only data sources of truth.
