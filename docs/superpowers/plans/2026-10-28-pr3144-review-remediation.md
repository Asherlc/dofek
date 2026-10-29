# PR 3144 Review Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix valid PR 3144 feedback, prove the final head passes CI, resolve the review, and perform the user-authorized merge.

**Architecture:** Preserve raw ingestion and server-side analytics. Add finite verified cadence repair phases, deterministic source priority, transactional step-workout grouping, and permanent response-version negotiation on existing APIs. Read-only planning and reviews can run in parallel; use one source implementer at a time and serialize database verification through the controller.

**Tech Stack:** Existing TypeScript/Zod/Drizzle, ClickHouse/dbt, Swift/HealthKit, Vitest and SwiftPM.

**Spec:** [Review remediation](../specs/2026-10-28-pr3144-review-remediation.md).

## Global Constraints

- Start on existing branch `slimy-unicorn`, reviewed base `5f130c59067ed5e8f5edae95cfcfd7a94fb0c6dd`. Do not switch/rebase/create branches.
- Keep all existing raw identity/overlap/association policies, 100-key batches and synchronous cleanup.
- No new dependencies/env vars, stored aggregates, client metric computation, truncation, retries, timeout changes, or disabled checks.
- The user approved existing-API response negotiation: legacy default, explicit new response on both clients.
- Only the controller commits/pushes and posts/resolves feedback after review; every new commit is pushed immediately. Preserve immutable per-task review artifacts.
- Serialize real-database tests; no service/resource operations without controller coordination. Never repeat a resource-rejected test by tuning limits.

## Review Focus

1. Alias expansion crossing 100 and retired groups: finite complete repair/rollback before dependent summaries (Task 3).
2. Same bundle, multiple display names/rules: deterministic cadence and provenance under reversed arrival (Task 3).
3. Old server/cache payloads and missing measurements: errors without crashes; legacy default safe; new clients retain partial rows (Task 4).
4. Sparse historical parent pages: no gap-wide workout enumeration, lost associations or early acknowledgment (Task 2).
5. Timestamp-like SQL, nonfinite XML and filesystem failure: no leaked payload, partial destructive import or hidden cause (Task 1).

## Task 1: Diagnostic privacy and XML import boundaries

**Files:** `scripts/clickhouse-ci-diagnostics.ts`, `scripts/collect-clickhouse-ci-diagnostics.ts` and their colocated tests; `src/providers/apple-health/{records,import,db-insertion}.ts` and affected colocated tests.

**Interfaces:** Preserve `collectClickHouseDiagnostics(options): Promise<{ failures: string[] }>` and CLI arguments. `parseRecord(attrs): HealthRecord | null` continues returning null for invalid values. Reuse the canonical running-type registration; raw metric-stream uploads retain every valid running sample.

- [x] Write RED public-artifact tests for timestamp-like SQL continuation, valid later log/error records and structured exception text; CLI filesystem error code without sensitive path; genuinely unset optional URL.
- [x] Write RED parser/import tests for Infinity, negative Infinity and overflow; show running samples reach the metric stream without entering the unused daily buffer.
- [x] Implement verified record framing, safe operation/error-code reporting and finite parser validation; filter unused running records before buffer insertion.
- [x] Run focused Docker-free tests, strict script types and applicable lint. Freeze an immutable diff/report for review; address findings before acceptance.

## Task 2: HealthKit transport, grouping and route forwarding

**Files:** `packages/mobile/lib/health-kit-sync.ts` and test; HealthKit query/transport/module Swift files and focused tests; server `health-kit-sync-processors.ts`, running-step repository and affected unit/integration tests; populated strain route test under `app-tests/(tabs)/strain.test.tsx`.

**Interfaces:** Existing full-sync and running-step payload/acknowledgment APIs remain. Use `SyncDatabase.transaction` and existing lock/presence/group-reconcile functions; no partial-list absence reconciliation. Workout discovery consumes raw parent intervals and still verifies forward HealthKit association.

- [x] Write RED ordering/count/error tests proving each non-additive type uploads before the next query; assert exact seven-day start/end dates with deterministic time.
- [x] Write RED real-Postgres grouping/lock/rollback/restore tests for the step-only path. Preserve existing manual-deletion, partial-list and idempotency cases.
- [x] Write RED Swift fixtures for sparse/overlapping parent intervals and complete association merging; preserve empty-page acknowledgment and native error behavior.
- [x] Implement per-type flushing, transaction/lock/reconcile and lossless interval-union discovery in both passes. Strengthen the route test with a populated existing fixture and row assertion.
- [x] Run focused mobile/server/Swift checks and controller-leased database cases. Freeze a review artifact/report; no broad native archive or UI server rerun locally.

## Task 3: Complete scoped cadence repairs and deterministic priorities

**Validation coordination:** The user approved CI's existing ClickHouse runner
after local memory failures persisted through one approved workspace restart.
Keep local database execution stopped. Complete independent Task 4 first, then
push a coherent regression checkpoint against the old repair orchestrator and
capture a genuine hosted >100-key assertion failure before implementing the
staged repair. Compiler, prerequisite, timeout and memory failures do not count
as behavioral RED. Database-backed SQL lint and integration GREEN remain
required on the final head; do not alter workflow settings or service limits.

**Files:** cadence SQL/model integration test; `src/db/activity-data-integrity-dbt.ts`, repair callers and tests; new focused `activity-data-integrity-cadence-scope.ts` with executable integration coverage. Follow the controller-reviewed finite-phase design in the task brief.

**Interfaces:** `runActivityIntegrityDbtBuild(input: ActivityIntegrityDbtBuildInput, clickHouse: ActivityIntegrityClickHouseClient): Promise<void>`. Keep injected `rebuildReadModels(input)` shape via production default closures. The identity resolver returns `{ activityIds: readonly string[]; cadenceActivityIds: readonly string[] }` for one user. Exact `activity_step_cadence_repair_activity_ids` dbt batches contain at most 100 canonical IDs; explicit `[]` selects zero.

- [x] Write RED engine tests for 101+ canonical keys reached through real member/revision aliases, stale cadence and summary correction, old-group tombstones, rollback and foreign-user fencing.
- [x] Write RED empty-initial-target and middle-batch failure cases; unit-test finite phase sequencing and failure propagation without substituting for engine tests.
- [x] Write RED mixed-name bundle selection with reversed input order, specificity/ties and unmatched fallback; assert cadence and selected display name.
- [x] Retain pre-upstream aliases, run upstream nine models, freeze expanded canonical scope, process disjoint verified 100-key cadence batches, then downstream five models. Preserve closure caps and fail on incomplete progress.
- [x] Replace arbitrary representative priority with all-name configured priority plus stable tie-break, preserving raw source grain.
- [ ] Run focused real-engine tests and SQL lint in the approved CI environment. Local types/lint and immutable source review pass; hosted engine acceptance remains required.

## Task 4: Versioned running wire contract and safe rendering

**Files:** new `packages/training/src/running-response.ts` and `training-chart-availability.ts` with colocated tests; server running router/contracts, `date-window.ts` endpoint metadata and affected tests; web running route/components/tests; mobile strain/card/query-boundary tests and affected fixtures. Preserve canonical repository behavior and its integration test.

**Interfaces:** Existing `running.dynamics` and `running.dynamicsV2` accept `responseVersion: 1 | 2`, default `1`, following existing response-version patterns. Version 1 satisfies historical numeric cadence/pace/distance with real finite values and exact old fields; version 2 preserves complete current nullable rows and cadence metadata. Preserve genuine zero values. Shared production exports are `runningResponseVersionSchema`, canonical `RunningDynamicsRow`, `runningDynamicsRowsResponseSchema`, `runningDynamicsResponseSchema`, `runningDynamicsResponseV2Schema`, `RunningDynamicsResponseV2`, `toRunningDynamicsRowsV1(rows)`, and `RUNNING_DYNAMICS_INVALID_RESPONSE_MESSAGE`. Keep legacy schema internals private. Use existing `selectedChartCustomRangeQuery` and change only the two endpoint input kinds to `custom`; the object input uses `selectedChartRangeSchema(endpoint)` and the response-version schema. New cache namespace is `running-response-negotiation-v1`; raw inputs already separate versions. Do not add a query factory or output version field.

- [x] Write RED default/explicit legacy projection tests using historical numeric assumptions; retain real-engine canonical form-only row coverage for version 2.
- [x] Write RED cold GET cache separation with actual running router/cache middleware, both-client request-version tests, malformed/old response rendering, Sentry reporting and valid stale-data preservation. A permissive legacy-first Zod union must not strip valid new metadata or downgrade malformed new payloads.
- [x] Extract one canonical shared response validation contract, preserve server-only metric/availability computation, and implement version negotiation with the existing custom-range helper. Keep current-version unions first and legacy shapes strict. Move only availability schema/type into the shared training package; keep its computation factory on the server and its existing public imports valid.
- [x] Update both clients to request version 2 and validate before card/table access. Preserve specific server errors and the accepted missing-metric UI.
- [x] Run focused shared/server/web/mobile tests and affected package typechecks/lint; freeze artifact/report for independent review.

## Final review, replies and merge

- [ ] Controller consolidates task reviews and runs Docker-free pre-push lint, Knip, root/server/web/mobile types and unit/mobile tests. Run database-backed SQL lint and integrations on CI under the user's approved validation direction. Keep native archive, strict SwiftLint and mutation gates in exact-head CI.
- [ ] Commit explicit reviewed paths in coherent commits and push every commit immediately; no force push or branch changes.
- [ ] Reply to all ten inline findings with concrete fix/evidence/commit links, correcting false premises without dismissing valid concerns; resolve those threads. Reply once to the review body for its native follow-up and three test nits.
- [ ] Monitor exact final-head required checks and new actionable feedback; fix genuine issues and rerun required checks. Do not administrator-bypass protections.
- [ ] Perform the user-authorized normal squash merge with expected head SHA. Verify merged state and merge commit; preserve this worktree.
- [ ] Record retrospective and all controller rulings, then remove only this completed plan's ignored scratch workspace.
