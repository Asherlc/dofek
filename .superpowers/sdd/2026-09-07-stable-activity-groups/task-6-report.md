# Task 6 report

Status: fix round 2 complete. Production/tests/docs committed as `dbd952cce`
(`Fix activity payload batch reconciliation`); push was attempted automatically
but the execution policy rejected the remote side effect, so the parent
orchestrator must push the local commit.

## Implementation

- `activity_sensor_summary_rows` and `activity_location_summary_rows` now derive current lifecycle identity from active `deduped_activities.activity_id`, never raw PostgreSQL member IDs. Scoped repair resolves member IDs through persisted membership and includes tombstoned prior group states, so a move invalidates both the old and current stable keys.
- `activity_location_sample` applies the same scoped member/group lookup. Its existing single-provider-track selection remains intact: the largest location track wins per stable group, with provider ID as the deterministic tie-breaker, so overlapping routes are not summed.
- `activity_summary_rows` maps raw CDC dirtiness through persisted `activity.group_id`, compares current state by stable group ID, and resolves scoped prior/current group state through the complete `deduped_activities FINAL` lifecycle. Sensor and location payloads remain independently group-keyed.
- `activity_vo2max_estimate` now publishes and invalidates only stable group UUIDs. It continues to read group-keyed, deduplicated sensor samples; raw member IDs are dirty inputs only.
- The integrity repair model list now runs `activity_location_sample`, both summary payload families, final activity summary, and VO2 in dependency order.
- The legacy TypeScript `v_activity` builder no longer computes overlap components or minimum-member UUIDs. It requires persisted non-null/non-zero group identity, publishes the group UUID, preserves active membership/source provenance, unions member bounds, and uses specificity/refinement/provider priority for bootstrap display metadata without adding a sensor dependency cycle.
- Migration 0078 recreates the legacy activity views from the corrected builder. The registry and real ClickHouse execution cover the forward migration and fail-loud missing-membership behavior.
- `analytics/README.md` documents stable summary lifecycle, representative-independent scalar/location hydration, nullable `source_activity_id` semantics, migration order, bounded sensor history replay, and the required downstream rebuild.

## Executable fixture and invariant

`src/db/activity-group-payload-union.integration.test.ts` now executes the real raw `activity` -> `activity_source_records` -> `deduped_activities` ranking path for a three-member group. The baseline has metadata-only Peloton cardio, WHOOP cycling/`commuting` plus heart rate, and an altitude/GPS route member; four altitude samples make the route member the actual winner while `commuting` survives independently. Changing real winning-sample ownership makes each member win without changing payload values or membership. The fixture asserts the real `primary_activity_id`, representative-owned canonical classification, and invariant heart-rate/elevation/GPS values plus populated payload fields. A null-linked ambient sample is retained in every group union.

The served scalar path remains `deduped_sensor` -> `activity_sensor_sample` -> `activity_sensor_summary_rows`; no served scalar model reads raw `ingest.metric_stream`. Nullable `source_activity_id` is used for representative richness and membership attribution: null is ambient/unlinked, while a non-null sample is eligible for every current group containing that member and is removed when that member leaves.

## Downstream/manual audit

- Group-stable: `activity_sensor_sample`, `activity_location_sample`, both activity summary payload tables, `activity_stream_points`, `activity_heart_rate_zones`, final `activity_summary_rows`, VO2, activity efficiency/polarization/power, hiking/cycling, and their daily/weekly consumers.
- Structural raw/member inputs retained intentionally: `activity_source_records` and duplicate-match evidence discover source/member changes before projecting persisted groups.
- Source-level reads retained intentionally: provider inventory/counts and sleep window association. They do not publish activity identity and changing them would exceed Task 6 scope.
- Manual/bootstrap `v_activity` is now at stable identity parity. Payload richness remains in dbt because pulling deduplicated sensor models into the bootstrap view would create the forbidden dependency cycle; migration 0078 prevents upgraded databases from retaining the old dynamic/min-member implementation.

## Red evidence

- `rtk bash -lc 'set -a; . ./.env.local; set +a; pnpm vitest run --project integration src/db/activity-group-payload-union.integration.test.ts'`: after correcting a fixture-only qualified alias, the real query returned zero/null sensor and location aggregates instead of average HR 110, elevation +10/-5, GPS, and six samples. Root cause: summary lifecycle joined stable sample keys to raw PostgreSQL member IDs.
- The scoped lifecycle case initially retained the prior group as active in sensor/location/final summary output. Root cause: scoped filters considered only active/current group rows instead of the complete persisted group lifecycle.
- Focused SQL/unit tests initially failed because VO2 selected raw `id`, the repair selection omitted location/VO2 consumers, the legacy builder still contained connected components/min-member identity, and migration 0078 did not exist.
- `activity_vo2max-stable-groups.integration.test.ts` initially could not emit a stable estimate from a raw member CDC change. It passes after mapping the dirty member through `group_id` while computing from group-keyed sensor samples.
- SQLFluff identified an unscoped group-state CTE in `activity_summary_rows`; guarding it with the existing scoped-refresh condition removed that new finding without changing executable output.

## Green verification

- `rtk pnpm vitest run --project unit analytics/models/read_models/read_model_microbatch.sql.test.ts analytics/models/read_models/activity_sensor_summary_rows.sql.test.ts analytics/models/read_models/activity_vo2max_estimate.sql.test.ts src/db/activity-data-integrity-dbt.test.ts src/db/clickhouse-migrations/registry.test.ts src/db/clickhouse-migrations/0078_stable_activity_read_views.test.ts src/db/clickhouse-read-models.test.ts src/db/clickhouse.test.ts`: 8 files, 80 tests passed.
- `rtk bash -lc 'set -a; . ./.env.local; set +a; pnpm vitest run --project integration src/db/activity-group-payload-union.integration.test.ts src/db/activity-vo2max-stable-groups.integration.test.ts src/db/activity-sensor-sample-read-model.integration.test.ts src/db/activity-sensor-summary-watermark.integration.test.ts src/db/activity-summary-canonical-ids.integration.test.ts src/db/clickhouse-migrations/0078_stable_activity_read_views.integration.test.ts src/db/clickhouse-migrations/0071_repair_canonical_activity_type_reads.integration.test.ts'`: 7 files, 20 tests passed against real ClickHouse.
- `rtk pnpm setup-db`: PostgreSQL had zero pending migrations; ClickHouse applied 0076, 0077, and 0078 to the long-lived workspace schema.
- `rtk pnpm analytics:build`: all 39 dbt models passed, with no warnings/errors/skips.
- `rtk pnpm typecheck`: passed.
- Escalated `rtk pnpm lint:sandbox`: passed every repository format and policy gate across 3,229 files.
- Focused SQLFluff over all five changed SQL models: every changed model is clean except the existing `activity_sensor_summary_rows.sql:20 ST03` false-positive described below.
- `rtk git diff --check`: clean.

## Validation prerequisites and known lint false-positive

The first `rtk pnpm analytics:build` failed on a stale local ClickHouse volume. First fatal application line: `Unknown expression or function identifier group_id in scope active_activity`; `deduped_sensor` also reported `Identifier samples.activity_id cannot be resolved`. The local schema predated migrations 0076/0077. Running the repository migration workflow applied 0076-0078, after which the unchanged build passed all 39 models. No retry, timeout, fallback, or production behavior was added.

The first final integration rerun was accidentally started without escalated loopback access and failed first with `connect EPERM 127.0.0.1:57038`. It was interrupted after the first readiness timeout and the identical command passed 20/20 with the required sandbox permission.

`pnpm lint:analytics-sql` still reports only:
`activity_sensor_summary_rows.sql:20 ST03 Query defines CTE "target_state" but does not use it.`
The CTE is referenced twice in incremental branches. A test-first explicit-join rewrite preserved executable behavior but did not change SQLFluff's result, so it was reverted. This is the same documented false-positive from Task 5; no suppression, noqa, or lint configuration change was added. All other changed SQL passes SQLFluff and the sensor model passes real ClickHouse and the full dbt build.

## Rollout

1. Apply PostgreSQL group migrations and ClickHouse migrations 0076-0078; wait for persisted `activity.group_id` membership to reach the ClickHouse mirror.
2. Reprocess the required bounded history through `sensor_scalar_sample`, then `deduped_sensor`, then the group-keyed sensor/location sample models. Existing pre-0077 rows intentionally retain null source attribution until this replay.
3. Full-refresh, in dependency order, `activity_sensor_summary_rows`, `activity_location_summary_rows`, `activity_summary_rows`, and `activity_vo2max_estimate`, using an explicitly verified retention-covering `initial_lookback_days`.
4. Run the existing targeted integrity refresh for affected current/member/prior IDs and verify prior group rows are tombstoned and stable group rows retain sensor/location payload.

No production deploy or historical rebuild was performed in this task.

## Fix round 1

The five Important review findings are closed:

- Sensor samples now reconcile current desired keys against prior active group-keyed rows. The executable move fixture keeps the retained old group's time window overlapping the departed sample: four route-linked samples and one ambient sample remain active, two departed WHOOP-linked keys tombstone, and the new group receives the WHOOP plus ambient samples.
- Location points now perform the same prior/current reconciliation after choosing one best provider track. A two-provider transition proves every old provider-A point tombstones and the summary contains only provider B's centroid and distance.
- Provider refinement is ranked independently from representative metadata. The real three-member rank fixture first proves the altitude-rich route member wins, then varies actual payload ownership until WHOOP and Peloton win; normalized `commuting` and all payload values survive each winner while `canonical_type` remains representative-owned.
- VO2 consumes explicit activity-refresh scope plus the complete deduped activity lifecycle. Its move fixture keeps new-group power samples older than the prior estimate, proving lifecycle scope—not sample freshness—tombstones the old estimate and recomputes the new stable group.
- Migration 0078 again excludes a whole group when a persisted member is provider-absent. The real migration view regression returned the group before the fix and no row afterward.

### Transition-first RED evidence

- Sensor move: focused ClickHouse execution expected the old linked rows to tombstone but received them as active because user/time overlap regenerated them without checking winning provenance membership.
- GPS switch: focused execution received both provider-A IDs with `is_deleted=0` after provider B won.
- Refinement: `-t "hydrates HR"` returned `provider_type: ""` when the route member won instead of WHOOP's normalized `commuting`.
- VO2: `-t "scoped member move"` tombstoned the old group but emitted no new-group estimate.
- 0078: `-t "provider-absent"` returned the active group UUID where the expected result was empty.

### Fix-round GREEN evidence

- `rtk bash -lc 'set -a; . ./.env.local; set +a; pnpm vitest run --project integration src/db/activity-group-payload-union.integration.test.ts src/db/activity-vo2max-stable-groups.integration.test.ts src/db/activity-sensor-sample-read-model.integration.test.ts src/db/activity-sensor-summary-watermark.integration.test.ts src/db/activity-summary-canonical-ids.integration.test.ts src/db/clickhouse-migrations/0078_stable_activity_read_views.integration.test.ts src/db/clickhouse-migrations/0071_repair_canonical_activity_type_reads.integration.test.ts'`: 7 files, 24 tests passed against real ClickHouse.
- `rtk pnpm vitest run --project unit analytics/models/read_models/read_model_microbatch.sql.test.ts analytics/models/read_models/activity_sensor_summary_rows.sql.test.ts analytics/models/read_models/activity_vo2max_estimate.sql.test.ts src/db/activity-data-integrity-dbt.test.ts src/db/clickhouse-migrations/registry.test.ts src/db/clickhouse-migrations/0078_stable_activity_read_views.test.ts src/db/clickhouse-read-models.test.ts src/db/clickhouse.test.ts`: 8 files, 81 tests passed.
- `rtk pnpm analytics:build`: 39/39 models passed, with no warnings, errors, or skips.
- `rtk pnpm typecheck`: passed with no TypeScript errors.
- Escalated `rtk pnpm lint:sandbox`: all format and policy gates passed across 3,229 files after its one requested formatter correction.
- Focused SQLFluff over the four changed dbt models passed. Full analytics lint retains only the documented unchanged `activity_sensor_summary_rows.sql:20 ST03` false-positive.
- `rtk git diff --check`: clean.

The first broader integration run exposed a stale fixture schema, not a production failure: `Identifier 'deduped.member_activity_ids' cannot be resolved` in `activity-sensor-sample-read-model.integration.test.ts`. Updating that fixture to the current lifecycle schema and nullable source attribution made the same seven-file command pass 24/24. The first sandboxed lint attempt stopped at `listen EPERM .../tsx-502/...pipe`; the identical escalated command reached the checks and passed after formatting.

### Fix-round rollout

The original rebuild ordering remains required. Rebuild `sensor_scalar_sample` and `deduped_sensor` first so linked provenance is populated, then rebuild group-keyed sensor and location sample tables before their summaries and VO2. This emits deterministic tombstones for retired group/sample/point keys rather than leaving legacy active rows. Scoped repair inputs must include current member IDs plus prior and current group/alias IDs discovered by reconciliation.

### Fix-round retrospective

- What went well: transition fixtures exposed lifecycle bugs that steady-state snapshots could not, especially overlapping retained windows and unchanged VO2 sample watermarks.
- What required investigation: ClickHouse's global alias analysis bound unqualified UNION output names across CTE branches. Distinct internal stale/group column names with explicit final remapping removed the ambiguity without changing keys.
- Useful context next time: every sample-level incremental model needs a desired-vs-prior reconciliation test whenever source ownership can change.
- Suggested guidance: document the `source_activity_id IS NULL OR current group contains source_activity_id` invariant alongside stable-group repair scope, and use `integration-tests-ready` for each membership/source transition.

## Concerns and retrospective

- What went well: the real three-member ClickHouse fixture made the identity/payload boundary observable in one assertion and caught lifecycle gaps that SQL-string tests could not. The VO2 and legacy-view tests prevented downstream split identity.
- What required investigation: stale local physical schemas produced genuine ClickHouse unknown-column errors despite current source definitions; applying migrations before dbt proved the rollout dependency. ClickHouse alias shadowing and SQLFluff's incremental-Jinja false-positive also required isolated checks.
- Useful context next time: start analytics validation with `pnpm setup-db` whenever a task follows a schema-owning task in the same long-lived workspace. Keep member IDs explicitly classified as provenance/dirty keys versus published identities during every downstream audit.
- Suggested guidance update: add “apply pending ClickHouse migrations before `pnpm analytics:build` in long-lived workspaces” to `docs/testing.md`; continue using `integration-tests-ready` for database behavior. A future SQL lint skill/runbook could record the narrowly reproduced dbt incremental ST03 limitation so agents do not repeatedly attempt semantic rewrites for it.

## Fix round 2

The two microbatch correctness findings are closed.

- `activity_sensor_sample` still uses daily dbt microbatches, but its prior-row
  reconciliation is now limited to the exact `(user_id, channel, recorded_at)`
  keys present in the injected source batch. A replayed active sample is mapped
  only to current groups that contain its non-null `source_activity_id`; a
  deletion has no desired active mapping and therefore tombstones existing
  mappings for that replayed key. Unrelated historical target rows are never
  compared with a one-batch source slice. `join_use_nulls=1` makes the
  left-anti-join tombstone predicate executable for UUID keys.
- `activity_location_sample` is now an ordinary append-incremental current-state
  reconciliation rather than an event-time microbatch. Raw arrival changes,
  activity-group lifecycle changes, and explicit repair scope select affected
  stable groups. Complete current location versions are then resolved only for
  those groups' current members, one provider track wins deterministically by
  complete active point count and provider ID, and only those groups' prior
  point IDs are reconciled. Losing-provider arrivals advance the affected
  group's source freshness even when the winning track does not change.
- `activity_location_summary_rows` now invalidates from the location sample
  table's monotonic `refresh_version`. This avoids comparing historical source
  timestamps with a summary row's wall-clock refresh and guarantees that a
  route-provider switch recomputes the visible centroid/distance.
- Location was removed from the microbatch-bounds contract, E2E vars, and
  microbatch documentation. Historical rollout now bounded-replays scalar
  staging/deduplication/sample models, full-refreshes the location current-state
  sample model, and then full-refreshes both summaries and downstream activity
  models in dependency order.

### Transition-first RED evidence

- `rtk pnpm test:integration -- src/db/activity-payload-dbt-microbatch.integration.test.ts`
  initially failed after the Sep 6 replay: both old and new group mappings were
  active instead of the old mapping being tombstoned. Inspecting the compiled
  batch showed a correctly injected source predicate but no emitted tombstone.
  Direct execution isolated the cause: with ClickHouse's default
  `join_use_nulls=0`, an unmatched non-nullable UUID became the zero UUID, so
  `activity_samples.activity_id IS NULL` was false.
- `rtk pnpm test:integration -- src/db/activity-payload-dbt-microbatch.integration.test.ts -t "preserves unrelated routes"`
  initially returned five active points after a partial provider-B arrival:
  provider A's complete three-point route plus B's two points. Expected output
  remained A's three points until B became the complete four-point winner.
- During GREEN implementation, the first incremental location compile failed
  with `Correlated subqueries are not supported in JOINs yet ...
  affected_groups`; fully qualified affected-key CTE outputs and non-correlated
  filtering fixed the ClickHouse analyzer shape without changing the design.
  The next behavioral run exposed the stale summary centroid (37.81 instead of
  37.915), which proved historical source-time watermark comparison could not
  observe the provider switch; `refresh_version` invalidation fixed it.

### Fix-round GREEN evidence

- `rtk pnpm test:integration -- src/db/activity-payload-dbt-microbatch.integration.test.ts`:
  1 file, 2 tests passed in 23.35s. The actual dbt-compiled transitions prove
  day-2 source isolation, replay-only sensor rekeying, old/new sensor summaries,
  unrelated-route preservation, partial-track stability, complete-track
  provider switching, all old-point tombstones, and the final B-only summary.
- `rtk pnpm test:integration -- src/db/activity-group-payload-union.integration.test.ts`:
  1 file, 4 tests passed against real ClickHouse.
- `rtk pnpm vitest run analytics/models/read_models/read_model_microbatch.sql.test.ts src/processing/analytics-microbatch-bounds.test.ts scripts/run-analytics-build.test.ts scripts/run-local-analytics-build.test.ts`:
  4 files, 52 tests passed.
- `rtk pnpm analytics:build`: all 39 models passed; the output identifies
  `activity_sensor_sample` as a four-batch microbatch model and
  `activity_location_sample` as one ordinary incremental model.
- Generated SQL inspection under `analytics/target/run` showed each sensor
  batch wrapping `deduped_sensor` with its exact daily `refreshed_at` bounds and
  joining prior target rows through `batch_sample_keys`. The location SQL reads
  complete `ingest.metric_stream` location state without an injected event-time
  predicate, builds `affected_groups`, and reads prior target rows only for
  reconciliation with those groups.
- `rtk pnpm typecheck`: `TypeScript: No errors found`.
- Escalated `rtk pnpm lint:sandbox`: passed all repository format and policy
  gates across 3,230 files.
- Focused SQLFluff on the three changed dbt models has no actionable layout or
  syntax finding. It emits only ST03 unused-CTE reports caused by selecting one
  Jinja branch: `activity_days` in the sensor model; `target_state`,
  `activity_group_state`, and `activity_members` in the location model; and
  `target_state`, `current_activity`, and `existing_summary` in the location
  summary. Each reported CTE is used in the opposite incremental/scoped branch
  and all three models execute in the real dbt transition suite and 39-model
  build. No suppression or lint configuration change was added.
- `rtk git diff --check`: clean.

The combined compatibility run passed all four payload-union tests, while the
independent Testcontainers-based microbatch-bounds suite timed out in its
`beforeAll` before executing a test: first fatal line `Error: Hook timed out in
180000ms` at `analytics-microbatch-bounds.integration.test.ts:69`. The actual
workspace-Compose dbt transitions and the full dbt build both passed; no timeout
or harness configuration was changed. An accidental ignored 109 MB
`analytics/.venv` created by a diagnostic compile was removed; it is fully
rebuildable and the repository continues to use `.venv-analytics`.

### Fix-round rollout and retrospective

Apply migrations 0076-0078 and wait for membership CDC as before. Replay
`sensor_scalar_sample`, `deduped_sensor`, and `activity_sensor_sample` over the
required source-refresh interval. Then full-refresh
`activity_location_sample`, followed by `activity_sensor_summary_rows`,
`activity_location_summary_rows`, `activity_summary_rows`, and
`activity_vo2max_estimate`. Scoped repairs must continue to carry prior/current
group and member/alias IDs; sensor membership moves additionally require the
underlying sample key to appear in an explicit upstream replay.

What went well: inspecting actual dbt-generated SQL separated source-batch
scope from target reconciliation and exposed a real ClickHouse null-join
semantic hidden by manual SQL rendering. What required investigation: location
correctness spans both complete provider-track selection and downstream summary
invalidation, so point rows could be correct while the served summary stayed
stale. Useful context next time: every event-time model that anti-joins a target
must prove source and target scopes independently, and summary dirty keys should
follow monotonic row versions when source event time can be historical.
Suggested guidance: add this microbatch anti-join rule and the
current-state-route/full-refresh rollout to `analytics/README.md` (completed in
this round); use `integration-tests-ready` for future dbt transition fixtures.
