# Production Data Loading Under One Second — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Display the correct requested page data in less than 1,000 ms on both
approved browser profiles, including cold loads, fresh query keys, and filters.

**Architecture:** Retain the current platform and API contracts. Add efficient
current-state heart-rate access and bounded incremental activity analytics, then
remove measured request/rendering delays. Track actual section completion and
prove the result with production browser and database evidence.

**Tech Stack:** TypeScript, PostgreSQL/Drizzle, ClickHouse/dbt, Redis/tRPC,
React/TanStack Query/Router/ECharts, Expo, Vitest, Cypress, Chrome DevTools.

**Spec:** [Approved design](../specs/2026-10-02-subsecond-page-loading-design.md).

**Status:** Design and plan approved. Task-by-task implementation with independent
review agents selected. Implementation is in progress; production acceptance is
not yet verified.

## Global Constraints

- “Display the relevant data for each audited page in **less than 1,000 ms**.”
- Desktop: “Chrome, 1440 × 1000, no CPU/network throttling, same audit workstation/location”.
- Mobile web: “Chrome, 390 × 844, scale factor 3, Fast 4G, 4× CPU slowdown”.
- “Run at least five observations of each required scenario and retain every result, including failures.”
- “Every successful required observation must be below 1,000 ms.”
- “Below-fold data must be ready within the same deadline; revealing it must not trigger another required data fetch.”
- “No new telemetry service or environment variable is required.”
- “Do not lengthen cache TTLs or hide a model backlog to meet the time budget.”
- “Native screens affected by shared APIs or loading behavior receive matching correctness and refresh-preservation changes.”
- Preserve canonical source resolution, access windows, user isolation, current API
  shapes, metric formulas, deletion behavior, and source-to-visible freshness.
- Work in the existing isolated checkout/branch; do not switch branches.
- Prefix terminal commands with `rtk`. Push every new commit.
- For every HTTP development server, run
  `/Users/asherlc/bin/paseo-quick-tunnel <port>`, keep it alive with the server,
  and report only its emitted `https://…trycloudflare.com` URL.
- Use existing dependencies. No retries, timeout increases, forced optimizer
  settings, feature-flag bridges, or raw-query fallback for missing new models.
- Read package READMEs/AGENTS before edits. Use the integration preparation
  workflow before database tests and the canonical deployment runbook for release.

## Review Focus

- **Obsolete responses/renderer callbacks:** an older date result must not finish
  the new measurement or replace its data; exercise in Tasks 1, 9, and 12.
- **Latest deletion/non-positive replacement:** an older positive sensor value
  must not be resurrected by early predicate filtering; exercise in Task 2.
- **Dirty-key backlog and processed-empty activities:** bounded builds must finish
  older work and remember empty/deleted results; exercise in Tasks 3–6.
- **Identity, timezone, and entitlement changes:** activity merges, DST, and
  user/access-window changes must not leak or reclassify data; exercise in Tasks
  2, 4, 5, 7, and 9.
- **Telemetry under consent/erasure and failed loads:** readiness events must omit
  identifying inputs and must distinguish failure from a successful fast load;
  exercise in Tasks 1, 11, and 12.

## Structure and sequencing

One plan coordinates three deliverable groups with shared acceptance criteria:
measurement/client behavior, database serving, and release acceptance. Each task
has its own test/review boundary. Keep model preparation commits before reader
cutover commits so production can prepare data without a runtime fallback.

| Owner | Files / responsibility |
|---|---|
| Web completion tracker | New `packages/web/src/lib/page-load-tracker.ts` and `page-load-context.tsx`; state transitions and React integration |
| Telemetry adapter | Existing `packages/web/src/lib/posthog.ts`, `App.tsx`, `routes/__root.tsx` |
| Audit coverage | New `docs/performance/page-load-acceptance.md` and `cypress/e2e/page-data-readiness.cy.ts` |
| Raw HR access | `src/metric-stream/clickhouse-table.ts`, new migration 0098, existing heart-rate repository |
| Sensor change index | `analytics/models/read_models/deduped_sensor.sql`, new migration 0099, new scoped macro |
| Pace results | New `analytics/models/read_models/activity_pace_curve.sql` |
| HR distribution | New `analytics/models/read_models/activity_heart_rate_distribution.sql` |
| Model lifecycle | `entrypoint.sh`, `src/processing/dataset-contracts.ts`, existing integration fixtures |
| Compact readers | Existing `clickhouse-activity-sensor-store.ts`, `training-repository.ts`, `heart-rate-zone-sql.ts` |
| Provider history | Existing `sync-repository.ts`, `routers/sync.ts` |
| Chart loading | Existing `DofekChart.tsx`, `ChartContainer.tsx`, query-owning pages/components |
| Refresh retention | Existing web DailyHeartRatePage/Training and mobile daily-heart-rate/strain screens |
| Initial bundle | Existing `packages/web/vite.config.ts`, root route; new `lib/echarts.ts` |
| Remaining slow queries | Named repositories in Task 8; exact fixes require its current child-query evidence |
| Release evidence | Existing loading runbook, incident baseline, and new dated after-audit |

Migration numbers 0098/0099 are next in this checkout. If concurrent work reserves
them, allocate the next free numbers and update this plan before implementation;
do not edit published historical migrations.

For every implementation task: red test → minimal change → green focused checks
→ review of requirements and code → commit/push. Do not add wall-clock assertions
to ordinary database unit/integration tests; measure performance in the controlled
benchmark. Run the complete validation gates in Task 13.

---

### Task 1: Record trustworthy page/section completion

**Files:** Create `packages/web/src/lib/page-load-tracker.ts`,
`page-load-tracker.test.ts`, `page-load-context.tsx`,
`page-load-context.test.tsx`, `cypress/e2e/page-data-readiness.cy.ts`, and
`docs/performance/page-load-acceptance.md`. Modify `App.tsx`,
`routes/__root.tsx`, `lib/posthog.ts`, `lib/posthog.test.ts`,
`pages/Dashboard.tsx`, and `pages/DailyHeartRatePage.tsx`.

**Interfaces:** Export `PageLoadTracker` for the React adapter. Constructor takes
`emit: (event: PageLoadEvent) => void`. Methods:
`begin({ route, kind, startedAt, sections }): number`;
`report({ generation, section, status, completedAt }): void`;
`cancel(generation: number, completedAt: number): void`.
Kind is `"navigation" | "filter"`; report status is
`"ready" | "empty" | "error"`. Export `PageLoadEvent` with `route: string`
(route template), `section?: string`, `generation: number`, `kind`,
`startedAt: number`, `completedAt: number`, `durationMs: number`, and outcome
`"ready" | "empty" | "error" | "cancelled"`. The PostHog adapter sends only route,
section, kind, duration, outcome, and the existing release metadata.

`PageLoadProvider` supplies the tracker/current generation;
`usePageLoadSection(section: string)` returns a generation-bound
`complete(status, completedAt)` callback. Require sections at begin time so
late-mounting insights cannot cause premature page completion. DOM consumers
complete after commit and the next paint opportunity; chart consumers use Task 9.

- [ ] Write tracker tests: begin at 100 with sections `["cards", "chart"]);
  report cards at 200 and chart at 450; expect exactly one ready page event with
  `durationMs: 350`. A new generation ignores the old generation's report.
  An error never emits ready; cancellation never emits ready; duplicate renderer
  callbacks do not emit duplicate completions. All-empty completion is empty;
  mixed data/empty completion is ready.

  ```ts
  it("waits for every required section in the current generation", () => {
    const events: PageLoadEvent[] = [];
    const tracker = new PageLoadTracker((event) => events.push(event));
    const generation = tracker.begin({
      route: "/", kind: "navigation", startedAt: 100,
      sections: ["cards", "chart"],
    });
    tracker.report({ generation, section: "cards", status: "ready", completedAt: 200 });
    expect(events.filter((event) => event.section === undefined)).toEqual([]);
    tracker.report({ generation, section: "chart", status: "ready", completedAt: 450 });
    expect(events.filter((event) => event.section === undefined)).toEqual([
      expect.objectContaining({ generation, outcome: "ready", durationMs: 350 }),
    ]);
  });
  ```

- [ ] Run `rtk proxy pnpm exec vitest run --project unit packages/web/src/lib/page-load-tracker.test.ts`;
  expect the new behavioral test to fail before implementation.
- [ ] Implement the tracker and React adapter. Capture full-navigation start from
  navigation time origin and client/filter start from the actual input event,
  retaining the start even if the route code mounts later. Cancel on route/user
  change; ignore obsolete completions.
- [ ] Record successful page completion with a browser PerformanceMeasure named
  `dofek.page.data-ready`, using the event's start/end and route, kind, outcome,
  and local generation as detail. Record errors/cancellation separately as
  `dofek.page.data-outcome`. Cypress and DevTools consume these local entries;
  PostHog export remains consent gated. Use the existing browser
  [User Timing API](https://www.w3.org/TR/user-timing/), without a new global
  diagnostic object or event bus.
- [ ] Test the adapter with fake frame callbacks: no ready event before paint,
  unmounted generation ignored, and consent/erasure disables emission. Assert
  telemetry payloads contain only the documented fields, not request keys,
  account IDs, health values, dates, or raw URLs.
- [ ] Wire Dashboard and Daily Heart Rate as initial production consumers. Cover
  Dashboard primary cards, conditional insights, and processing status separately.
  Add a delayed-response Cypress case that verifies readiness occurs after the
  late section, with actual data visible. Use existing test login/seeding.
- [ ] Create the acceptance inventory from every row of the audit, including
  route owner, default required sections, populated/empty fixture, and filter
  inputs. Store production identifiers only in ignored local evidence.
- [ ] Run the new unit suites and focused Cypress case; inspect one trace to
  verify the marker follows the actual render. Record the current failures of
  the one-second budget without installing a failing global CI timing test.
- [ ] Review generation/paint/privacy behavior; commit
  `feat: measure page data readiness`, then `rtk git push`.

### Task 2: Bound Daily Heart Rate reads without losing sources

**Files:** Modify `src/metric-stream/clickhouse-table.ts`,
`src/db/clickhouse-migrations/registry.ts`,
`packages/server/src/repositories/heart-rate-repository.ts`, and its existing
unit/integration tests. Create
`src/db/clickhouse-migrations/0098_heart_rate_source_access.ts` and its executable
`.integration.test.ts`.

**Interfaces:** Preserve
`HeartRateRepository.dailyBySource(date: string): Promise<HeartRateSourceSeries[]>`.
Add `metricStreamUserChannelRecordedAtProjectionDefinition(): string` and
constant `METRIC_STREAM_USER_CHANNEL_RECORDED_AT_PROJECTION` for both bootstrap
and migration. Projection name: `by_user_channel_recorded_at`; columns:
user_id, activity_id, channel, recorded_at, id, provider_id, scalar, version,
ingested_at, is_deleted. Order by user_id, channel, recorded_at, activity_id, id.

- [ ] Extend integration fixtures with a newer deleted version of a positive row,
  a newer zero/null replacement, an identical replay, provider overlap, two users,
  and both DST transition dates. Assert only the winning live positive rows
  contribute; source series remain separate and minute counts/statistics match
  independently calculated expectations.
- [ ] Capture the deployed engine version, current EXPLAIN, and baseline
  read_rows/read_bytes using the audit query. Check tie behavior against the
  actual writer contract before selecting a version expression.
- [ ] Run `rtk proxy pnpm test:integration -- packages/server/src/repositories/heart-rate-repository.integration.test.ts`
  and the new migration test; demonstrate the new access-path expectation fails
  on the old schema. Existing semantic tests may already pass and become parity
  tests; do not fabricate a semantic failure.
- [ ] Add the covering projection to current bootstrap and a schema-only forward
  migration. Preserve the raw replacement key and merge/deletion settings.
  Existing provider inventory projections serve different predicates and lack
  scalar/channel; do not delete them without a consumer/plan comparison.
- [ ] Rewrite the reader to select complete winning tuples by the raw logical
  replacement identity before filtering deletion/value. Apply only identity-safe
  time/channel/user bounds early, then retain existing minute/statistic output.
  Use normal optimizer selection; add no forced-projection setting.
- [ ] On a controlled scaled fixture, verify EXPLAIN/query_log selects the new
  projection and reads the requested time/channel slice. Compare results with
  the original query before and after background merges. Execute migration twice
  to prove idempotence without replaying historical migrations.
- [ ] Run focused unit/integration tests; record uncached duration and reduced
  rows/bytes. Review version, DST, and projection materialization requirements.
  Commit `perf: bound daily heart rate source reads`; push.

### Task 3: Add bounded dirty-key selection for activity analytics

**Files:** Modify `analytics/models/read_models/deduped_sensor.sql`,
`src/db/clickhouse-migrations/registry.ts`. Create
`src/db/clickhouse-migrations/0099_activity_sensor_day_versions.ts`,
its `.integration.test.ts`,
`analytics/macros/activity_sensor_dirty_keys.sql`, and
`analytics/models/read_models/activity-performance-test-helpers.ts`.

**Interfaces:** Projection `by_user_channel_day_refresh` exposes
`(user_id, channel, recorded_date, max(refresh_version) AS source_refresh_version)`.
Macro `activity_sensor_dirty_keys(channel, target_relation, batch_size=32)`
produces canonical user/activity keys, current/prior bounds, activity version,
and source sensor version. Tasks 4/5 persist those per-key versions.

- [ ] Write executable tests with 65 dirty activities, an older key, a deleted
  activity, a cross-midnight window, and a processed-empty key. With batch size
  32, assert at most 32 keys selected per cycle and eventual completion of all
  65; new arrivals cannot starve the older key. Empty results must not become
  dirty again indefinitely.
- [ ] Run the new migration integration suite; verify the missing compact index
  is the initial failure. Use existing isolated ClickHouse helpers.
- [ ] Add the projection to dbt's current table definition and the schema-only
  migration, preserving replacement and projection-rebuild behavior. Query its
  max versions without FINAL, since obsolete rows cannot reduce a max watermark.
  Follow migration 0097's existing-table inspection for installations where dbt
  has not created the table; the dbt definition supplies it on fresh installs.
- [ ] Implement bounded selection from compact day versions and current activity
  lifecycle state. Include both prior and current bounds for changed windows.
  Compare the complete source-version tuple, not one global maximum. Filter
  user/channel/day before sample expansion.
- [ ] Add deletion, resurrection, source-priority change, merge/split, and
  midnight-boundary assertions to the shared fixtures. Do not infer exact
  temporal eligibility from activity_sensor_sample when it differs from the
  existing request; Tasks 4/5 read canonical deduped_sensor for parity.
- [ ] Run the focused real-engine tests and `rtk proxy pnpm lint:analytics-policy`.
  Review marker lifecycle and boundedness; commit
  `perf: index activity sensor change windows`; push.

### Task 4: Materialize exact per-activity pace durations

**Files:** Create `analytics/models/read_models/activity_pace_curve.sql` and
`activity_pace_curve.integration.test.ts`. Modify `entrypoint.sh`,
`src/processing/dataset-contracts.ts`, its tests, and
`analytics/README.md`. Extend current-schema integration helpers in
`packages/server/src/routers/clickhouse-integration-test-models.ts`,
`clickhouse-integration-test-helpers.ts`, and
`packages/server/src/repositories/test-helpers.ts`.

**Interfaces:** Model `analytics.activity_pace_curve` has user_id UUID,
activity_id UUID, duration_seconds UInt32, best_speed Nullable(Float64),
started_at DateTime64(6,'UTC'), source_activity_version UInt64,
source_sensor_version UInt64, refresh_version UInt64, is_deleted UInt8,
refreshed_at DateTime64(9,'UTC'). ReplacingMergeTree key:
`(user_id, activity_id, duration_seconds)`. Emit all 12 duration keys, including
tombstoned/unavailable results, so processed-empty state remains recorded.

- [ ] Create a fixture with ten one-second samples at 4 m/s. Assert 5-second
  best speed is 4 and a 15-second result is unavailable. Add a 5 m/s activity,
  then delete it; verify the remaining range winner would be 4 m/s. Add
  irregular spacing, zero/negative/null speeds, ties, and a cross-midnight
  activity with independently calculated expected values.
- [ ] Run `rtk proxy pnpm test:integration -- analytics/models/read_models/activity_pace_curve.integration.test.ts`;
  expect missing model/result failure.
- [ ] Implement the model using Task 3 keys and the exact current request
  algorithm: sample interval rounding, cumulative-window mean, fixed durations
  `[5,15,30,60,120,300,600,1200,1800,3600,5400,7200]`, and no final pace rounding.
  Read only selected canonical deduped activity windows. Keep single-threaded
  bounded model work and model-local materialized CTEs where reused.
- [ ] Run incremental corrections/deletion/empty/merge-window tests using the
  shared fixtures. Verify source versions advance only when the selected work
  completes; unchanged builds leave equivalent target state.
- [ ] Register the model after its dependencies in entrypoint/model inventory.
  Assign it once to the training dataset; include `durationCurves` in that
  dataset's cache families and `metric_stream` in relevant source data types.
  Keep existing freshnessTargetMs unchanged. Add contract behavior tests for
  pending/ready transitions, not static file-content tests.
- [ ] Run focused integration tests, analytics lint/policy, and dataset contract
  tests. Review parity with the old query on the same source watermark.
  Commit `perf: materialize activity pace curves`; push.

### Task 5: Materialize exact heart-rate distributions

**Files:** Create
`analytics/models/read_models/activity_heart_rate_distribution.sql` and
`activity_heart_rate_distribution.integration.test.ts`. Update the same
entrypoint, dataset contract, README, and current-schema helper files as Task 4.

**Interfaces:** Model `analytics.activity_heart_rate_distribution` has
user_id UUID, activity_id UUID, started_at DateTime64(6,'UTC'),
samples Array(Tuple(heart_rate Float64, sample_count UInt64)),
source_activity_version UInt64, source_sensor_version UInt64,
refresh_version UInt64, is_deleted UInt8, refreshed_at DateTime64(9,'UTC').
Key is `(user_id, activity_id)`. An active processed-empty activity has an empty
array; deleted/ineligible activity state is tombstoned.

- [ ] Seed HR values 129.5, 130, 143.5, and 144, including a repeat of 130.
  Assert exact values/counts survive (130 has count 2), with no rounding bins.
  Include provider overlap and another activity's linked sample inside the
  temporal window; expected eligibility must match the current Training query.
  In `it("preserves fractional HR values and exact sample counts")`, normalize
  database tuples to numeric pairs and assert
  `expect(samples).toEqual([[129.5, 1], [130, 2], [143.5, 1], [144, 1]])`.
- [ ] Run `rtk proxy pnpm test:integration -- analytics/models/read_models/activity_heart_rate_distribution.integration.test.ts`;
  expect missing model/result failure.
- [ ] Implement exact value/count aggregation over only Task 3's selected
  deduped sensor windows, using the existing Training eligibility predicate.
  Do not apply an RHR/max-HR profile or assign zones in this model.
- [ ] Verify late updates, removal of the last sample, resurrection, overlapping
  and changed windows, merges/splits, and a second user. An all-empty activity
  must retain its completed source versions.
- [ ] Register build order and training dataset ownership once. Run real-engine
  tests, analytics lint/policy, and processing contract tests. Review that
  existing activity_heart_rate_zones remains semantically unchanged.
- [ ] Commit `perf: materialize activity heart rate counts`; push.
  Mark this model-preparation commit boundary for Task 13's first release.

### Task 6: Serve compact pace/HR results and prove freshness

**Files:** Modify
`packages/server/src/repositories/clickhouse-activity-sensor-store.ts`,
`training-repository.ts`, `heart-rate-zone-sql.ts`, their unit tests,
and `src/processing/dataset-contracts.ts` if runtime contract tests expose a
missing cache dependency. Create
`packages/server/src/repositories/training-repository.integration.test.ts` and
`clickhouse-activity-sensor-store-pace.integration.test.ts`.
Extend relevant existing processing integration tests.

**Interfaces:** Keep `getPaceCurveRows(days, userId, timezone)` and
`TrainingRepository.getHrZones(days)` response signatures unchanged.
Add `heartRateZoneWeightedCountColumns(valueExpression, countExpression,
expressions): string` alongside the existing count helper; it sums sample_count
under exactly the same shared zone boundary predicates.

- [ ] Write parity tests: 4 m/s produces 250.0 s/km; removal of a 5 m/s winner
  restores 250.0. Finite/All ranges and local dates choose the same eligible
  activity set. Check response shapes and entitlement boundaries.
- [ ] For maximum HR 200 and resting HR 60, use Task 5's values and assert zone
  counts 1, 3, 1 in the first three zones. Change daily RHR/profile inputs and
  assert the original Training rules are reapplied to the compact counts;
  activity-detail's recent-sleep baseline remains unchanged.
  In `it("applies training zone boundaries to weighted samples")`, assert
  `expect(zoneCounts.slice(0, 3)).toEqual([1, 3, 1])`; extract zoneCounts from
  the existing response fields, without changing the public response shape.
- [ ] Run the new integration suites before switching readers. The compact-read
  behavior must fail on the old implementation using fixtures whose source
  tables are deliberately unavailable to the serving client.
- [ ] Read selected compact activity results and aggregate on the server.
  Keep date/type/access restrictions, max-HR availability, fallback rules,
  result ordering, rounding, and the intensity-distribution calculation.
  Missing required model data/prerequisites must raise an actionable error.
- [ ] Exercise processing lifecycle: add a sample, build, refresh registered
  query keys, then delete and repeat. Assert data and readiness use the same
  generation; cached old values cannot be labeled current. Compare measured
  source-to-visible lag with the baseline and fail the freshness gate if worse
  than the existing contract. Test a failed build and an unfinished batch.
- [ ] Run focused unit/integration suites; compare uncached plans/read rows/time
  on a production-scale controlled dataset. Review values and freshness before
  enabling the readers in the second production release.
- [ ] Commit `perf: serve compact training sensor analytics`; push.

### Task 7: Bound provider history to the displayed provider set

**Files:** Modify `packages/server/src/repositories/sync-repository.ts`,
`routers/sync.ts`, and their existing unit/integration tests.

**Interfaces:** Change the repository method to
`getRecentLogsByProvider(providerIds: readonly string[], limitPerProvider: number):
Promise<Map<string, ProviderRecentSyncLog[]>>`.
The router passes IDs from its already-loaded `getAllProviders()` result and 3.

- [ ] Capture a current child span/EXPLAIN for the ranked history query. Record
  baseline rows/time. If another child dominates, retain this scoped diagnosis
  and feed the remaining cause into Task 8 rather than claiming full resolution.
- [ ] Seed two requested providers, one other provider, two users, more
  than three records each, and tied timestamps with ordered UUIDs. Assert exactly
  the latest three per requested provider ordered by synced_at DESC, id DESC;
  missing history and an empty requested list return valid empty maps.
- [ ] Run `rtk proxy pnpm test:integration -- packages/server/src/repositories/sync-repository.integration.test.ts`
  plus the router unit suite; expect the new scoped contract to fail.
- [ ] Use the requested provider list as the left relation and an indexed lateral
  top-N lookup per provider. Preserve auth-error, latest-success, and connection
  logic. Do not build the provider list by scanning all historical sync rows.
  [PostgreSQL LATERAL](https://www.postgresql.org/docs/current/queries-table-expressions.html#QUERIES-LATERAL).
- [ ] Verify current index usage and tie-sort cost on the real plan. Add/replace
  an index only if that measured plan requires it; record its exact schema and
  migration in this task before editing. Avoid redundant indexes.
- [ ] Run focused checks; compare the entire provider response and uncached
  latency. Review user scoping and ties; commit
  `perf: bound provider sync history reads`; push.

### Task 8: Resolve every remaining measured slow query

**Files:** Inspect the exact owners below and their existing tests. Record evidence
and the resulting concrete amendments in `docs/performance/page-load-acceptance.md`
and this plan before editing each owner.

| Procedure | Source owner |
|---|---|
| activity.list | `packages/server/src/repositories/activity-repository.ts` |
| correlation.computeV2 / observations | `packages/server/src/repositories/correlation-repository.ts` |
| insights.compute | `packages/server/src/repositories/insights-repository.ts` |
| nutritionAnalytics.* | `packages/server/src/repositories/nutrition-analytics-repository.ts` |
| food.byDateV2 | `packages/server/src/repositories/food-read-repository.ts` |
| processing.status | `packages/server/src/repositories/processing-repository.ts` |
| processing.dataQuality | `packages/server/src/repositories/data-quality-repository.ts` |
| Climbing detail dependency | `packages/web/src/pages/ActivityDetailPage.tsx` and `pages/activity-detail/components/ClimbingEntryBreakdown.tsx` |

**Interfaces:** Keep existing public method/tRPC contracts. Output from this task
is a measured fix and parity test for every remaining over-budget family, or an
explicit unresolved cause that blocks final acceptance.

- [ ] For each row, reproduce a fresh-key request and record the parent, database
  children, queue wait, and CPU/transform portion. PostgreSQL work needs a bounded
  read-only EXPLAIN ANALYZE; ClickHouse work needs query ID/plan/rows/bytes.
  Preserve private parameters locally. Do not replay large queries concurrently.
- [ ] Add a concrete implementation subtask for each confirmed cause, naming
  exact files, signature changes if any, the smallest query/algorithm change,
  independently expected values, and its red/green command. Have that subtask
  reviewed before its code change. This evidence checkpoint is mandatory:
  the audit established slow parents, not the current cause of every child.
- [ ] Pin these correctness cases in the owning database tests: activity
  filtering/count/pagination across merged IDs and access windows; lagged
  correlation with missing days and unchanged interval math; overlapping
  nutrition sources and ambiguous days; processing failure/pending/completed
  generations; climbing details for canonical/member IDs.
- [ ] Implement only the proven cause per reviewed subtask. Activity list already
  limits relational rows before summary hydration; do not prescribe that as a
  new fix without showing which view/child remains broad. Nutrition data must
  keep canonical view-based source resolution. Correlation must not reduce its
  statistical iterations or precision simply to meet time.
- [ ] Run the affected real-engine and unit tests, then repeat the same fresh-key
  benchmark. Commit/push each independently reviewed fix. Recheck dependent
  pages after shared nutrition/activity improvements.
- [ ] Do not close this task while an audited family's uncached serving path is
  unresolved. A required architecture change outside the approved design needs
  the repository's explicit strategy review; a speculative cache or timeout is
  not an acceptable substitute.

### Task 9: Preserve current charts and scope their loading state

**Files:** Modify `packages/web/src/components/DofekChart.tsx`,
`ChartContainer.tsx`, `TrainingInsightsPanel.tsx`, their tests/stories,
`packages/web/src/App.tsx`, `pages/DailyHeartRatePage.tsx`,
`routes/training/index.tsx`, `lib/trainingQueryOptions.ts`,
`lib/trainingDaysContext.tsx`, and existing tests.
Modify `packages/mobile/app/daily-heart-rate.tsx`,
`app/(tabs)/strain.tsx`, and their tests under `app-tests/`.
Reuse `packages/scoring/src/loading-policy.ts`; update its behavior/tests only
where needed. Remove `FetchingContext.tsx` when all consumers are migrated.

**Interfaces:** Add explicit `refreshing?: boolean` to DofekChart and
ChartContainer; charts consume only their owning query state. DofekChart accepts
`onDataRendered?: () => void`, bound to the current option/result generation.
Keep all existing event handlers working.

- [ ] Write component tests with an unrelated pending query: a resolved empty
  chart displays its empty message, and a populated chart stays usable. With
  its own refreshing=true, show a refreshing indicator that leaves data usable.
- [ ] Write web/native interaction tests: select day B while day A is visible;
  keep A's chart and label while B waits; render B only after B resolves.
  If B fails, retain A with the actual error. A late response for B after the
  user selects C cannot overwrite C. Repeat for Training's 90→30-day range.
- [ ] Run focused unit/mobile suites and observe the expected blanking/loading
  failures. Use TanStack's previous-data support and retain the last successful
  presentation with its original input label. Do not attach the newly requested
  date to placeholder data through a new select callback.
- [ ] Migrate query-owning chart callers to explicit state; use
  `rtk rg -n 'useFetchingCount|FetchingProvider|<DofekChart|<ChartContainer' packages/web/src`
  to produce the complete caller checklist in the working notes. Keep the
  chart's displayed axis range bound to its displayed data while refreshing.
- [ ] Implement renderer completion through ECharts' completion event without
  overwriting existing callbacks. Cancel/ignore events from replaced options;
  connect the generation-bound callback from Task 1. Test both the first render
  and a second result on the same chart instance.
- [ ] Run focused web/mobile tests, chart stories, and Cypress Training/Heart
  Rate scenarios with controlled response delays. Inspect a native Release
  runtime for the matching refresh behavior; do not infer it from web tests.
- [ ] Review stale labels, errors, account changes, and renderer timing; commit
  `fix: preserve charts through data refreshes`; push.

### Task 10: Split routes and reduce chart startup cost

**Files:** Modify `packages/web/vite.config.ts`,
`packages/web/src/components/DofekChart.tsx`,
`packages/web/src/routeTree.gen.ts` via the
normal generator, and route component exports as required by the router plugin.
Create `packages/web/src/lib/echarts.ts`. Update existing chart render tests and
`cypress/e2e/landing.cy.ts`, `training.cy.ts`, and `cycling.cy.ts`.

**Interfaces:** Export the configured ECharts instance from `lib/echarts.ts`
as the single runtime import consumed by `echarts-for-react/lib/core`.
Keep the existing chart option/event/renderer API.

- [ ] Add browser tests that load a public page with an empty browser cache and
  verify public content renders independently of the chart module. Add actual
  render checks for line, bar, scatter, pie, radar, and calendar heatmap charts,
  including tooltip, legend, accessibility, mark/zoom features used by callers.
- [ ] Build the unchanged app and save its import graph/transfer/runtime baseline.
  The current eager chart dependency should fail the public-page behavior check.
- [ ] Enable TanStack automatic route splitting while retaining valid explicit
  lazy routes. Move exports that keep whole page modules eagerly reachable to
  their existing owning component files; regenerate the route tree normally.
- [ ] Use ECharts' existing tree-shakeable core interface and register every
  component actually used by current options. Preserve supported Canvas/SVG
  modes. Fetch the selected chart route's chunk during route resolution so a
  chart page does not gain a data-then-library waterfall.
  [ECharts modular imports](https://echarts.apache.org/handbook/en/basics/import/).
- [ ] Run `rtk proxy pnpm --filter dofek-web build`,
  `rtk proxy pnpm --filter dofek-web typecheck`, and `rtk proxy pnpm size`;
  all must pass without raising size limits. Run focused chart/browser tests.
- [ ] Compare cold public and authenticated mobile traces, including actual
  rendered data. Review chunk graphs and all chart types; commit
  `perf: split page and chart startup code`; push.

### Task 11: Shorten safe bootstrap and remaining client critical paths

**Files:** Modify `packages/web/src/routes/__root.tsx`, its tests,
`lib/auth-context.tsx` only if the root change requires it,
`pages/Dashboard.tsx`, `pages/ActivityDetailPage.tsx`,
`pages/activity-detail/components/ClimbingEntryBreakdown.tsx`,
`lib/posthog.ts`, and `index.css` only for measured costs.
Update related unit tests and existing login/account-erasure/navigation Cypress
suites. Native behavior changes belong in the matching existing screens too.

**Interfaces:** Preserve authentication context, erasure, redirect, and query
response contracts; no new unauthenticated data endpoint.

- [ ] Delay session bootstrap in a browser test: public landing text must render,
  while an authenticated route exposes no protected data. Test signed-in login
  redirects, bootstrap failure/retry, logout/user switch, and account erasure.
- [ ] Run the root/login tests red; render safe public content independently of
  the session request. Keep account-erasure cleanup and protected-data guards.
- [ ] Trace Dashboard's secondary insights and climbing detail. Where inputs are
  already available, test and remove only the artificial dependency; preserve
  canonical-ID resolution and server authorization. Add exact tests before
  changing each dependency and mirror changed native flows.
- [ ] Profile remaining mobile time in chart updates, transition animation, and
  PostHog startup. For each over-budget cause, add the focused behavior test,
  make the measured change, and compare the same trace. Keep consent, exception
  reporting, and product features intact.
- [ ] Run the relevant suites and cold mobile benchmark. Review auth/erasure and
  completed-chart behavior; commit each independent measured fix and push.

### Task 12: Complete readiness coverage and acceptance fixtures

**Files:** Modify Task 1's acceptance document, tracker/adapter as needed,
`cypress/e2e/page-data-readiness.cy.ts`, and the exact route owners below.
Add tests beside changed source files; keep native route tests under app-tests.

| Route family | Web owner |
|---|---|
| Dashboard / Sleep / Body | `pages/Dashboard.tsx`, `pages/SleepPage.tsx`, `pages/BodyPage.tsx` |
| Activities / activity detail | `pages/ActivitiesPage.tsx`, `pages/ActivityDetailPage.tsx` |
| Daily Heart Rate | `pages/DailyHeartRatePage.tsx` |
| Training and sports | `routes/training/index.tsx`, `running.tsx`, `cycling.tsx`, `strength.lazy.tsx`, `recovery.tsx`, `climbing.tsx`, `hiking.tsx`, `endurance.tsx` |
| Nutrition / analytics / supplements | `pages/NutritionPage.tsx`, `pages/NutritionAnalyticsPage.tsx`, `routes/nutrition/supplements.tsx` |
| Providers/settings / Data Quality | `pages/SettingsPage.tsx`, `pages/DataQualityPage.tsx` |
| Correlation / experiments / tracking | `pages/CorrelationExplorerPage.tsx`, `pages/PersonalExperimentsPage.tsx`, `pages/TrackingPage.tsx` |
| Reports | `routes/health-report.tsx`, `weekly-report.tsx`, `monthly-report.tsx` |
| Behavior / cycle | `routes/behavior-impact.tsx`, `routes/cycle.tsx` |
| Alerts / clinical / More / integrations / admin | `pages/AlertsPage.tsx`, `pages/clinical-records.tsx`, `pages/MorePage.tsx`, `pages/DeveloperIntegrationsPage.tsx`, `pages/AdminPage.tsx` |
| Public landing/login | `pages/LandingPage.tsx`, `routes/login.tsx` |

All owner paths above are relative to `packages/web/src/`; sports filenames are
relative to `routes/training/`, and report filenames to `routes/`.

**Interfaces:** Every page uses Task 1's section contract; charts use Task 9's
current-result completion callback. No global network-idle definition.

- [ ] For each audited view, add a functional fixture that delays its last
  required section. Assert there is no successful page-ready event until that
  section has current data and is rendered; a valid empty section can complete,
  while an error reports failure. Conditional insights require resolved absence.
- [ ] Run the added cases red, then connect the page's explicit required sections
  and filter generation. Include default below-fold data and processing widgets.
  Static pages use a single content section.
- [ ] Test rapid back/forward, cached revisits, background polling, empty-to-data
  transitions, and out-of-order results. Confirm old labels/charts are not
  credited as the new selected input. No raw filter values enter telemetry.
- [ ] Run the full coverage suite and compare a sample of emitted completion
  times with independent DevTools traces/screenshots, including mobile charts.
  Document any genuine fixture limitations without substituting empty views.
- [ ] Review the acceptance inventory against every audit row; commit
  `feat: track data readiness across audited pages`; push.

### Task 13: Validate and release without missing-model windows

**Files:** Update `docs/performance/loading-performance-runbook.md`,
`docs/clickhouse-read-model-deploy-runbook.md`, `analytics/README.md`, and
`docs/production-incident-baseline.md` with applicable verified behavior.
No diagnostic-only runtime switches or ad-hoc release workflows.

**Interfaces:** Release A contains the schema/index/model preparation through
Task 5, with existing readers. Release B introduces the compact readers and
validated client changes after the model data is ready. Record exact reviewed
commit/image digests; use the canonical release mechanism, not branch switching
or manual service-image changes.

- [ ] Run `rtk proxy pnpm lint`, root/server/web/mobile typechecks,
  `rtk proxy pnpm exec vitest run --project unit --project mobile`,
  `rtk proxy pnpm test:integration`, web build, size checks, and full browser
  E2E according to [testing.md](../../testing.md). CI must pass its normal
  mutation/integration/build checks. Resolve actual failures without weakening
  the checks. Follow native Release audit guidance for affected screen behavior.
- [ ] Review the whole branch for API semantics, new model lineage/freshness,
  query isolation, real chart rendering, and omitted audited pages. Address
  findings and rerun only affected checks unless a broader failure requires more.
- [ ] Prepare the exact two-release operator sequence using
  [deploy/README.md](../../../deploy/README.md). Keep historical projection
  materialization and initial model population out of schema migration bodies.
  Use existing bounded activity refresh scopes and record counts/progress.
- [ ] Release preparation first; materialize the new access paths and build
  historical activity keys in bounded batches. Confirm no unfinished keys,
  deleted winners, stale versions, or growing backlog. Compare read-only sample
  outputs against the previous readers on the same source watermark.
- [ ] Release the reader/client image only after all readiness/freshness gates
  pass. Confirm emitted asset hashes and all replicas run the intended digest.
  Preserve forward-only migration and canonical rollback procedures.
- [ ] If release authorization is still required by the applicable release
  workflow, present the exact validated commits/images and bounded operator
  commands for that final approval. Continue all authorized preparation first.
- [ ] Record deployment evidence and remaining risks. A successful deployment
  alone does not satisfy the page-loading goal.

### Task 14: Prove the one-second production target

**Files:** Create a dated follow-up report under `docs/performance/`; update
`page-load-acceptance.md`, the loading runbook, documentation index, and
production incident baseline.

**Interfaces:** Use the approved spec's full acceptance matrix and Task 12
readiness events, cross-checked by independent Chrome traces.

- [ ] Run at least five serial observations per required scenario on each
  approved profile: cold browser, confirmed first data requests, warm revisit,
  in-app navigation, and filter changes. Preserve account authentication safely;
  never print credentials or flush shared production caches.
- [ ] Record every observation, outcome, asset/server-cache evidence, release,
  client render timestamp, and matching slow/query spans. All successful required
  results must be <1,000 ms. Unknown cache states do not establish a cache-miss
  pass; absent production population does not establish populated-view timing.
- [ ] Check new-observation and deletion freshness, queue wait, query rows/bytes,
  engine pressure, and analytics backlog alongside latency. Compare source-to-
  visible timing with the baseline so a stale fast answer cannot pass.
- [ ] For any failure, identify its exact remaining critical path, reopen the
  owning task, apply a tested change within the approved design, and rerun that
  scenario plus affected regressions. If the design itself is insufficient,
  invoke the strategy review gate rather than lowering the target.
- [ ] Publish the before/after matrix with counts, medians, maxima, and outcomes.
  Mark the incident resolved only when the measured target and correctness/
  freshness gates pass. If a blocker prevents measurement, state production
  acceptance is unverified.
- [ ] Validate documentation; commit/push the results. End with a short
  retrospective and the concrete runbook improvements learned during execution.

## Review and execution decision

The user approved this plan and selected task-by-task implementation with separate
review agents. Model lifecycle/version mistakes can silently alter health data,
so each task receives a review before dependent implementation proceeds.

The plan deliberately reserves Task 8's code decisions for current child-query
evidence. That is an explicit diagnostic deliverable and review checkpoint, not
permission to omit those endpoints or choose speculative fixes.
