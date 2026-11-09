# Erasure Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans
> to implement this plan task-by-task. The user approved implementation followed
> by merge; continue inline in the existing isolated workspace.

**Goal:** Close the account-erasure publication, recovery, cutover and key-binding
gaps, address current review findings, verify the candidate, then merge PR3234.

**Architecture:** Reuse the existing durable publication owner and checkpoint
store. All actual writers cooperate on one publication resource. Unknown remote
or child outcomes retain the barrier; terminal failures can replay the same
request and frozen deletion without discarding retained proof.

**Tech Stack:** TypeScript, PostgreSQL/Drizzle, ClickHouse SDK, pinned dbt adapter,
Vitest and the existing GitHub CI workflows.

**Spec:** [Approved decision package](../../plans/2026-11-09-erasure-safety-decisions.md).
User approval: “Implement the safety plan, then merge (Recommended).”

## Global Constraints

- Work only on `account-erasure-hardening` in its existing workspace; no rebase,
  branch switch, further agents or production action.
- Push every new commit. Preserve Kafka changes inherited from main; do not
  import the tiered-storage branch.
- No new tracking framework, tables, keyring, secret, automatic owner clearance,
  guessed legacy routes or changed test gates/timeouts/retries.
- Keep full 500-table/1 MiB catalog scope, current snapshot/identifier budgets,
  direct-owner precedence and fail-closed unknown identity/type behavior.
- Use real database tests for SQL, ownership, race and mutation semantics; exact
  26.6/26.10 qualification one engine at a time for new engine-sensitive behavior.
- Shell commands use RTK and explicit workspace cwd; Compose uses the existing
  workspace wrapper. Do not replay historical production identity scans.

## Review Focus

- A foreign explicit owner remains foreign even when an activity ID overlaps.
- A lease can expire while waiting for a row lock; stale progress must fail.
- A zero-exit child is not sufficient unless its actual adapter writes are terminal.
- A previously admitted executor may outlive its process/session; no auto-clear.
- Empty/missing-key lookups must not certify erasure after credential key changes.

### Task 1: Archive ownership and focused review regressions

**Files:** `src/account-erasure/archive-erasure.ts`, its unit test;
`src/account-erasure/clickhouse-erasure.integration.test.ts`;
`src/jobs/account-erasure-phase-runner.test.ts`;
`docs/production-incident-baseline.md`.

**Interfaces:** Preserve public erasure/store APIs. Normalize parsed UUID owner
values before comparison, retaining explicit foreign-owner precedence.

- [ ] Add uppercase target/foreign-owner archive cases; observe the target case
  fail before fixing comparison. Include verification after actual rewrite.
- [ ] Forward SDK `close` in the existing integration wrapper; retain teardown.
- [ ] Restore pending-drain/capture ordering and initial archive cursor assertions
  through the phase runner's public function.
- [ ] Run `pnpm vitest run --project unit src/account-erasure/archive-erasure.test.ts src/jobs/account-erasure-phase-runner.test.ts --retry=0`.
  Expected: all pass; mutation of ownership/order/cursor behavior must fail.
- [ ] Link successful exact-head mutation CI evidence in the incident entry;
  reply to comments 4514843894/3911/3962/4071/4086 with exact evidence.
- [ ] Review actual diff, commit and push this bounded fix.

### Task 2: Lease boundaries and support-required retry state

**Files:** `src/db/account-erasure-processing.ts`, its integration test;
`src/account-erasure/identifier-store.ts`, its integration test;
`src/db/account-erasure.ts`, its unit/integration tests;
`src/jobs/process-account-erasure-request.ts`, its unit/integration tests;
shared account-erasure status package if needed for identical web/mobile copy.

**Interfaces:** Keep existing progress/lease APIs. Support-required snapshot
failures remain terminal to automatic dispatch/claim until repaired.

- [ ] Add real-PG lock-contention cases: establish an unexpired lease using DB
  time, prove the operation is waiting, expire it while held, then release and
  assert no renewal/progress/identifier access succeeds. Strengthen the existing
  renewal regression rather than relying on a one-second setup window.
- [ ] Lock the exact request row before checking `clock_timestamp()` in progress
  writes and store access, using the already established renewal pattern.
- [ ] Add overdue/support-message and dispatcher/claim regressions, observe RED,
  preserve the sanitized support reason and exclude support-required failures
  from normal retries. Preserve useful errors and both clients' shared message.
- [ ] Run affected unit suites and real-PG suites with generated workspace URLs
  and `TEST_DATABASE_URL`. Expected: stale owners cannot advance, support state
  remains actionable, ordinary transient failures remain eligible for retry.
- [ ] Reply to 4514844024/4039/4056/4107/4127; review, commit and push.

### Task 3: Legacy cutover and retained-key binding

**Files:** `drizzle/0179_account_erasure_identifiers.sql` and existing migration
integration tests; `src/account-erasure/identifier-store.ts` and integration test;
`docs/account-erasure-runbook.md`, `docs/credential-encryption.md`.

**Interfaces:** Persist key binding in the existing
`postgres_identifier_capture` checkpoint. Existing retained-state APIs reject
missing/mismatched binding before lookup or progress, including empty input.

- [ ] Add migration regression for a scrubbed unfinished legacy request; observe
  RED, then reject all `status <> 'completed'` under the existing table lock.
- [ ] Add real-PG tests for changed master key, namespace/name, capture reentry and
  concurrent different-key workers; preserve identifiers/cursors/proof on failure.
  Observe RED before persisting the request-scoped derived binding atomically
  with initial capture and checking it on access/reentry.
- [ ] Verify original configuration resumes correctly and normal PII scrub drops
  the binding. Do not implement in-place re-key or a second keyring.
- [ ] Run affected real-PG suites. Expected: no lookup miss can imply absence
  under changed keys; completed/scrubbed legacy state alone permits cutover.
- [ ] Update drain/rotation runbooks; reply to 4507302089/2107; commit and push.

### Task 4: Durable terminal ownership and physical replay

**Files:** `src/analytics/analytics-query-owner.ts`, its unit/integration tests;
`src/jobs/account-erasure-runtime.ts`, its tests;
`src/account-erasure/clickhouse-physical-erasure.ts` and existing real-engine tests.

**Interfaces:** Add one domain-specific
`AnalyticsQueryOwner.runSynchronousDbt(operation: () => Promise<number>): Promise<number>`
only for actual dbt callers. Register child admission before spawn in existing
owner state; do not present a synthetic child ID as a remote query ID. Reuse one
request intent across erasure preparation/fence/apply so a terminal failure can
resume before unrelated work is admitted.

- [ ] Add regressions for child pending/abnormal exit, callback return with child
  outstanding, parent/PG loss and attempted replacement. Observe RED; extend only
  existing owner state. Successful qualified completion releases; uncertainty
  remains non-quiescent across executors.
- [ ] Reproduce failed final erasure followed by its preparation retry; use the
  same durable request intent and retain all physical checkpoints. Verify another
  account cannot steal an outstanding intent and safe retry can later unblock it.
- [ ] Add real-engine admission-before-dispatch and lost-response tests. Only an
  owner safely admitted by the durable resource may replay the exact frozen
  DELETE; retain old/new parts and mutation lineage. Ambiguous old owners remain
  blocked; absent native evidence never means success.
- [ ] Run owner/runtime units, real owner PG/CH tests and physical regressions.
  Expected: no early release or unsafe replay; terminal retries make progress.
- [ ] Reply to 4514844008/4507305294 with actual tests; review, commit and push.

### Task 5: Actual sink admission boundary

**Files:** `src/metric-stream/clickhouse-sink.ts`, its unit/integration tests and
test helpers; existing account-erasure concurrency diagnostic evidence.

**Interfaces:** The production `handleEvents` callback acquires the existing
publication owner before fence membership and supplies its owned client for all
batch effects. Derive stable batch intent from existing topic/partition/offset
context; keep existing acknowledgement and offset order.

- [ ] Add a deterministic real-database regression using the actual production
  callback: delay admission/fence/read/write, activate erasure, replace consumer
  and assert no resurrection, early offsets/ack or unrelated-owner deletion.
- [ ] Observe RED before wiring the owner. Maintain Kafka heartbeats while lock
  admission waits through the existing heartbeat helper; close owned resources.
- [ ] Run sink units and focused real-PG/CH concurrency cases. Expected: account
  fence and writes share ownership through fully consumed terminal completion.
- [ ] Preserve the historical helper diagnostic as evidence; production tests,
  not a passing helper alone, discharge 4507302091/5287. Review, commit and push.

### Task 6: Actual dbt, repair and cycling writers

**Files:** `scripts/run-analytics-build.ts`, `scripts/run-local-analytics-build.ts`
and tests; `src/db/activity-data-integrity-dbt.ts` and its integration tests;
`src/analytics/cycling-power-projector.ts` and tests;
`analytics/profiles.yml`, appropriate analytics/operator runbooks.

**Interfaces:** Use Task 4's owned child operation and pass an owned client to
projector publication. No raw-client fallback, nested publication lock or new
environment variable. Preserve bounded repair scopes and selected models.

- [ ] Qualify the pinned adapter's stock profile settings and consumed responses
  against real ClickHouse before treating successful child closure as terminal.
  Use synchronous inserts, buffered responses and synchronous mutation settings.
- [ ] Add actual entrypoint races for normal/local builds and both bounded repair
  paths; parent/child loss must retain the barrier. Observe RED before wiring
  admission around source reads, child build and projector writes.
- [ ] Make projector publication require the owner; update all real callers and
  retain its existing fence predicates and source/version correctness tests.
- [ ] Run focused script units and real adapter/projector/repair concurrency cases;
  audit all checked-in writable dbt/projector callers again. Expected: erasure
  cannot certify while any admitted writer can still publish.
- [ ] Update runbooks for canonical entrypoints/direct privileged SQL exclusion;
  reply to 4507305306; review, commit and push.

### Task 7: Qualification, review and merge

- [ ] Run affected full unit/integration tiers, mutation selections, lint and root,
  server/web typechecks; qualify engine-sensitive changes on exact 26.6/26.10
  sequentially without historical audits, increased limits or changed gates.
- [ ] Review plan/spec coverage and actual diff; use existing review workflows,
  resolve only implemented/verified or specifically disproved findings and reply
  to PR-level feedback too. Do not mark accepted-but-unfixed safety work fixed.
- [ ] Verify exact latest head CI and all review conversations settled. If main
  moved, assess the actual merge diff, preserve both append histories and repeat
  only checks justified by conflicts/integration changes.
- [ ] Update PR/evidence/progress truthfully, then perform normal PR merge pinned
  to that exact head, as explicitly authorized. No admin bypass/settings change,
  production action, workspace deletion or branch switch.
