# HealthKit Running Measurement Ingestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Ingest supported raw HealthKit running measurements through native sync and XML import.
**Architecture:** Reuse existing metric channels and deletion boundaries. Normalize units once on the server; expand condensed native running series before transport.
**Tech Stack:** TypeScript, Swift/HealthKit, Vitest, Swift XCTest, existing metric-stream publisher.
**Spec:** `docs/superpowers/specs/2026-10-28-healthkit-running-ingestion.md`

## Global Constraints

- Keep raw data in the existing Redpanda/R2/ClickHouse path; no derived Postgres fields.
- Compute metrics on the server; native code only reads/converts/transports observations.
- No new dependencies, environment variables, branches, or production mutations.
- Test behavior before implementation; use real database tests for database semantics.
- Preserve web/mobile parity through the shared serving API; Tasks 1–3 retain the chart contract, and Task 4 adds the specified shared cadence evidence.
- Do not consume calorie expenditure estimates.

## Review Focus

- XML values in cm, m, seconds, milliseconds, km/h, and m/s must reach canonical units.
- A deleted condensed parent must tombstone all its points without affecting another source/user.
- Unequal condensed series sizes must not become a mean of means; retain actual point values.
- Failed series extraction must not acknowledge an anchor or silently drop points.
- Full historical sync and background observer sync must include all added types and respect erasure cutoffs.

### Task 1: Server and XML running quantity ingestion

**Files:** Existing Apple Health ingestion/processor/deletion files and colocated tests; introduce one provider-local shared running quantity module with production consumers if needed.
**Interfaces:** Consumes existing HealthKit type/value/unit and XML HealthRecord. Produces existing metric stream rows with channels/units defined by the spec; native point identity continues to use `hk:<parentUUID>` and recorded timestamp.

- [x] Write failing behavior tests for all five API/XML mappings, compatible unit conversions, unsupported units, preserved identity/source attribution, and deletion routing.
- [x] Run the focused tests and record the expected failures before production edits.
- [x] Add the shared running mapping/conversion and wire API routing, stream publication, XML import routing/publication, and anchored deletion. Keep existing non-running behavior intact.
- [x] Verify the focused processor/router/XML/deletion suites, lint touched TypeScript, and run root/server typechecks. Expected: all focused tests pass and no new lint/type errors.
- [x] Commit and push the complete reviewed task; record tests and remaining concerns in the report.

### Task 2: Native and mobile running quantity synchronization

**Files:** HealthKitTypes.swift, HealthKitQueries.swift, native sample/anchored query transport, a focused series transport helper if required, native tests, mobile health-kit-sync.ts and its tests, affected native/module docs.
**Interfaces:** Produces existing HealthKitSample objects in the canonical units from the spec. Expanded observations retain their parent's UUID with distinct precise timestamps; existing parent UUID deletion applies unchanged.

- [x] Write failing native tests for authorization/observer membership, preferred units, ordinary and condensed sample transport, distinct fractional point identity, series failure propagation, and account cutoff behavior. Write failing mobile tests that verify initial and anchored uploads of all five running types.
- [x] Run tests and record expected failures before production edits.
- [x] Add running quantity read/observer/sync inclusion and extraction. Expand only the affected running quantity series; reuse normal sample transport for other types. Preserve existing anchor commit-after-upload semantics.
- [x] Verify focused native/mobile suites, run the canonical native coverage command, typecheck mobile, and run the complete unit/mobile tier. Expected: passing checks; report every failure with its first error and cause.
- [x] Update Apple Health documentation and incident evidence with official citations and the native release/authorization/history requirement. Commit and push; request task review.

## Raw step cadence extension

**Spec:** `docs/superpowers/specs/2026-10-28-running-step-cadence.md`
The user chose raw underlying step intervals. Global constraints above remain
binding. Cadence is calculated only in analytics from observed disjoint raw
intervals; no all-day raw step duplicate, upstream-total fallback, synthetic
canonical cadence sample, or client-side rate calculation.

### Task 3: Native raw running-step snapshots/deltas and dedicated ingestion

**Files:** HealthKit native query/transport helpers and tests; module bridge/index; mobile sync orchestration/tests; server running-step router/processor/repository and tests; shared workout upsert boundary; affected docs.
**Interfaces:** Add `RunningStepSample extends HealthKitSample { workoutUuids: string[] }`, a native range snapshot returning `{workouts: WorkoutSample[], samples: RunningStepSample[]}`, and an anchored delta also returning `{deletedUUIDs: string[], queryId: string | null, hasMore: boolean}`. Add `healthKitSync.pushRunningStepSamples({workouts, samples})`; output `{inserted: number}` or an actionable thrown error. Raw metadata keys: `interval_end`, `source_bundle`, `workout_uuids`. Use channel `step_count` and parent `hk:<UUID>` tombstone identity. Reuse existing anchor completion with StepCount type identifier.

- [x] Write failing tests for associated raw series transport, association merge, snapshot plus delta full sync, step/workout observer refresh, historical delta additions/deletions, bounded 500-parent pagination including pages with no associated runs, failed upload/read/later-page anchor handling, separate daily totals routing, raw publishing units/interval identity, ownership, and additive workout upserts without absence reconciliation.
- [x] Run focused native/mobile/server tests and record meaningful RED failures.
- [x] Implement the dedicated raw interval path and synchronization exactly as the raw cadence spec requires. Do not compute cadence or change analytics in this task.
- [x] Verify native coverage, bridge parsing, mobile/server/root typechecks and focused tests; preserve non-running and daily-step regressions. Expected: all affected checks pass. Record exact environment/test failures rather than bypassing gates.
- [x] Document the new raw payload and native release/history boundary, commit explicit paths and push. Produce task report and request review.

### Task 4: Bounded interval cadence analytics and shared chart behavior

**Files:** New `analytics/models/read_models/activity_step_cadence_rows.sql`, shared summary model and relevant table/test helpers if needed; production model selection and dataset contracts; current summary DDL/view and a forward-only ClickHouse migration; running repository/router and tests; web cadence/form rendering and a mobile running training card with tests/stories; affected documentation and incident baseline.
**Interfaces:** Consume latest raw `step_count` events with metadata from Task3 and current user-scoped workout UUID/member mapping. Produce activity-grain cadence plus observed seconds/source evidence, refresh version/timestamp and lifecycle tombstones. Feed the existing `avg_cadence` summary field only when positive direct cadence is absent. Materialize cadence_basis, cadence_observed_seconds, cadence_coverage_percent atomically with avg_cadence and expose cadenceBasis/cadenceObservedSeconds/cadenceCoveragePercent. Both clients render source basis and supplied coverage; existing numeric API fields remain server-computed.

- [ ] Write real ClickHouse regressions covering weighted counts across unequal durations, one source, overlapping source/interval rejection, raw parent/group deduplication, ownership, invalid intervals, direct precedence, incremental add/change/delete/restore and canonical membership changes. Write failing running query tests for ground-contact display, nullable source names, and the explicit cadence empty-state message; add web/mobile behavior tests and stories for recorded versus interval-derived cadence, partial coverage, missing form values, stale refetch data, errors and saved date range.
- [ ] Run the focused regressions against the current implementation and capture RED before model/server changes.
- [ ] Implement bounded dirty-key cadence refresh using existing ingestion/day-change evidence and current membership, then wire summary consumers, production model lists and processing readiness. Preserve null rather than fabricate values when evidence is absent. Add cadence evidence to the same summary row, render it on web and the equivalent mobile training card, and visually inspect their stories using tunneled preview servers.
- [ ] Verify focused executable model/repository tests, source policies, SQL lint, typechecks, full lint and full unit/mobile suite. Run relevant integration tests against current workspace services. Expected: passing checks without retries or increased limits.
- [ ] Update active Apple Health/analytics docs with official citations and production incident evidence, including what still requires release/device validation. Commit and push, request final whole-branch review and address valid findings.

Task4 fixture anchors: one source with 150 steps over 60 seconds and 450 steps over 120 seconds
must yield 200 steps/min (the unweighted average 187.5 is wrong); direct cadence 172
must win over that 200. A valid source with configured higher priority must win
even if another source has more coverage. Nested interval overlap must be tested
using an earlier long interval enclosing two later short intervals. Restoring a
second workout in another canonical group must make a shared child's association
ambiguous for the first group too, even if that first group's own row did not
change. Test more than 100 dirty groups to prove batched consumption doesn't skip
remaining keys, and an unchanged subsequent cycle to prove processed-empty rows
and stable signatures prevent endless refresh.
