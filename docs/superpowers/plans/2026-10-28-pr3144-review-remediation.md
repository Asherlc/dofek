# PR 3144 Review Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix valid PR 3144 feedback, prove the final head passes CI, resolve the review, and perform the user-authorized merge.

**Architecture:** Preserve raw ingestion and server-side analytics. Add finite verified cadence repair phases, deterministic source priority, transactional step-workout grouping, and permanent response-version negotiation on existing APIs. Read-only planning and reviews can run in parallel; use one source implementer at a time and serialize database verification through the controller.

**Tech Stack:** Existing TypeScript/Zod/Drizzle, ClickHouse/dbt, Swift/HealthKit, Vitest and SwiftPM.

**Spec:** [Review remediation](../specs/2026-10-28-pr3144-review-remediation.md).

## Global Constraints

- Start on existing branch `slimy-unicorn`, reviewed base `5f130c59067ed5e8f5edae95cfcfd7a94fb0c6dd`. Do not switch/rebase/create branches.
- Keep all existing raw identity/overlap/association policies, 100-key batches and synchronous cleanup.
- No new application dependencies/env vars, stored aggregates, client metric computation, truncation, retries, timeout changes, or disabled checks. Task 6 permits the approved conditional replacement of the native development tool.
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

## Task 5: Compact canonical dbt scope transport

**Approved 2026-10-29.** Follow the finite staged repair from Task 3. Current
head is `d14c21ec90d42bd9bf65b6e9a7c53d05dbd91b07`. Repeated scope literals
exceed the unchanged query-size limit; the approved solution is one packed
UUID input and shared scope expression per model, not a different phase plan.

**Files:** scope and HealthKit revision macros; exact cadence macro; all 15
scoped model headers; runner and canonical encoder; scoped production/test
callers and actual engine fixtures. Controller owns human documentation.

- [x] Add failing encoder/runner boundary tests and actual-engine maximum-scope
  generated-statement coverage. Existing hosted query-size failure is preserved
  as semantic evidence; local database execution remains stopped.
- [x] Replace the internal literal-list input with one validated base64 value
  containing complete 16-byte UUIDs. Reject invalid UUID/base64/length/cap inputs
  explicitly; preserve byte order, zeros, high-bit values and exact membership.
- [x] Emit the scope expression once per scoped model; preserve user fencing,
  HealthKit sibling and historical alias expansion, global cadence association
  checks, 10,000/32 closure caps, exact batches of 100 and explicit empty target.
  Migrate every writer/reader/renderer in one canonical path with no dual input.
- [ ] Run focused Docker-free unit/types/lint checks; freeze and independently
  review the patch. In CI execute complete maximum-payload dbt statements with
  sparse fixtures, plus all 101 correction and fault/rollback lifecycle cases.
  Do not claim success from SELECT size or YAML transport alone.
  Source checks and independent review are complete; actual hosted acceptance
  remains pending.

## Task 6: Evaluate and conditionally migrate native mutation tooling

**Approved 2026-10-29.** An independent read-only repository / disposable-copy
evaluation may run alongside Task 5. Keep exactly one repository source writer;
begin migration only after Task 5 freezes and the evaluation evidence passes
independent review. Evaluation may build the tool and run bounded disposable
fixtures but must not modify product sources or run a broad native campaign.

- [x] Verify official release identity/version/provenance and inspect the plan,
  discovery/error and report/score contracts. Prove correct per-file candidates
  for the actual Boolean fallback and unary negation; validate source inventory
  and hashes, positive controls, zero sites, missing/unreadable/malformed source
  and stale plans. Do not infer safety from a successful generic CLI command.
- [x] Prove generated mutations compile, change meaningful observable behavior
  and are killed by relevant tests; characterize build-error/timeouts/skipped
  outcomes and preserve current gate semantics. Freeze evaluation evidence for
  independent review before deciding whether the migration condition is met.
- [x] If verified, migrate every Swift mutation consumer to one pinned canonical
  MutantKit toolchain using TypeScript repository automation. Update wrapper,
  tests, workflow/config/tool pins and human docs together. Retain strict source
  validation, complete result inventory, positive work and unchanged score gates.
  No Muter coexistence, local fork, source exclusions or zero-work acceptance.
- [ ] Run focused wrapper/tool/native behavior checks and independent scoped
  review; require actual existing native mutation CI acceptance on the final head.
  If evaluation cannot meet the condition, record exact evidence and request
  direction before selecting another strategy.

## Task 7: Newly reported sync and import failure boundaries

- [x] Independently triage both new review findings. Preserve original step
  rejection/anchor behavior and strict XML unit normalization.
- [x] Prove RED/GREEN public-path regressions for independent sleep/clinical
  uploads on step failure and whole-window XML validation before destructive
  replacement. Move the new step stage after existing stages and use the
  existing parser/normalizer for a bounded-memory read-only preflight.
- [ ] Independently review the bounded four-file correction and consolidate
  checks before push. Resolve both feedback threads with concrete evidence.

## Task 8: Final hosted verification boundaries

- [x] Correct the wrapper's outcome-specific official check applicability while
  retaining every applicable source/archive/identity/count/positive-work gate.
  Actual crash-only and assertion-only archives replay and pass trust; 102
  focused tests and independent scoped review pass.
- [x] Correct the capacity fixture's native UUID versus string ordering and
  separate direct runner contracts from repair/rollback lifecycle tests. All
  six complete cases remain byte-identical; scoped review and local static
  checks pass. Preserve the existing four serial shards and every time budget.
- [x] Triage all six native RunningStep survivors. Add the concrete discovered
  workout cutoff regression: 121 baseline tests pass and the exact OR mutant
  fails three assertions. Preserve the five consumer-equivalent comparator
  outcomes without suppression or a new score policy.
- [ ] Complete the final native regression scoped review and all exact-head
  hosted gates, including every selected native job and all four full database
  shards with both capacity phases. Prior passing cases are checkpoint evidence.

## Final acceptance after approved follow-up

- [ ] Controller consolidates task reviews and runs Docker-free pre-push lint, Knip, root/server/web/mobile types and unit/mobile tests. Run database-backed SQL lint and integrations on CI under the user's approved validation direction. Keep native archive, strict SwiftLint and mutation gates in exact-head CI.
- [ ] Commit explicit reviewed paths in coherent commits and push every commit immediately; no force push or branch changes.
- [ ] Reply to all ten inline findings with concrete fix/evidence/commit links, correcting false premises without dismissing valid concerns; resolve those threads. Reply once to the review body for its native follow-up and three test nits.
- [ ] Monitor exact final-head required checks and new actionable feedback; fix genuine issues and rerun required checks. Do not administrator-bypass protections.
- [ ] Perform the user-authorized normal squash merge with expected head SHA. Verify merged state and merge commit; preserve this worktree.
- [ ] Record retrospective and all controller rulings, then remove only this completed plan's ignored scratch workspace.
