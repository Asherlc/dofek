# Processing Inactivity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep old, productive processing operations eligible for downstream reconciliation while abandoning genuinely inactive work after 12 hours.

**Architecture:** Reuse the creation times of durable producer-generated reconciliation outbox rows. The existing pending-operation query computes the newest output time; its existing stale branch uses that value without changing operation identity, receipt evidence, timers or storage.

**Tech Stack:** TypeScript, Drizzle/PostgreSQL, ClickHouse and Vitest.

**Spec:** [Approved design](../specs/2026-11-11-processing-inactivity-design.md).

## Global Constraints

- Keep `STALE_OPERATION_THRESHOLD_MS = 12 * 60 * 60 * 1_000` and the strict greater-than boundary.
- Use `MAX(outbox.created_at)` as the inactivity reference; reconciliation/dispatch bookkeeping must not refresh it.
- Preserve exact marker/batch receipt checks, ingest completion ordering, oldest-pending ordering, limits and analytics dispatch behavior.
- No dependency, schema, environment-variable, timeout, retry, public API or client UI change; web/mobile share the same backend correction.
- Work on this branch only. No production writes, deployment, queue resume, operation recovery or issue closure in this implementation task.
- Report architectural uncertainty or concurrent-publication concerns before expanding the approach. No worker delegation or premium-model switch.

## Review Focus

- Eight-day-old operation with recent producer output must wait for replication, not be abandoned (integration regression).
- Mixed old/new output rows must use their maximum timestamp while preserving pending ordering (same integration fixture).
- Exactly 12 hours inactive stays eligible; one millisecond beyond is stale (unit boundary cases).
- Fresh polling/dispatch bookkeeping must not keep unchanged old output alive (integration regression).
- Fully matching evidence must still finish an old operation and request analytics once (integration completion plus existing duplicate-dispatch coverage).

---

### Task 1: Base abandonment on durable output inactivity

**Files:**
- Modify `src/processing/processing-reconciler.ts` — pending-row schema, selection and stale comparison only.
- Modify `src/processing/processing-reconciler.test.ts` — typed mock rows and timestamp boundary coverage.
- Modify `src/processing/processing-reconciler.integration.test.ts` — real PostgreSQL/ClickHouse regressions.
- Modify `docs/processing-status-runbook.md` — explain the durable output inactivity clock and its 12-hour cutoff, citing the reconciler.

**Interfaces:** Keep `reconcilePendingProcessingOperations(input: ReconcilePendingProcessingOperationsInput): Promise<ProcessingReconciliationResult>` and its callers unchanged. Rename the internal selected timestamp to `last_output_at`; parse it as a date. Do not export new test-only helpers.

- [x] **Step 1: Add the failing real-engine regression.** Use the existing minimal schema setup and public event-store writers. Create an operation dated eight days earlier, an old outbox batch and a fresh second output. With exact destination evidence missing, assert `abandoned: 0`, pending work preserved and no `processing_stalled` fact. Then insert every required real ClickHouse marker/receipt, finish ingest and require normal completion plus one analytics request. Isolate/complete fixture work so later cases do not inherit pending operations.
- [x] **Step 2: Add stale and boundary coverage.** Backdate both operation and producer outbox rows beyond the threshold, add fresh CDC/dispatch bookkeeping, and require abandonment with persisted `processing_stalled` and completed outbox. Unit cases freeze `Date.now()` and pin exactly 12 hours versus 12 hours plus one millisecond. Update existing unit mock rows to the new selected timestamp field without weakening assertions. Do not assert SQL text as a substitute for the executable database behavior.
- [x] **Step 3: Run RED.** After the lead confirms the shared local validation slot, run the focused unit and integration files using the generated workspace URLs. Capture the exact command, failed assertion and first fatal line. The old-operation/fresh-output regression must fail against unchanged production source for premature abandonment. Prerequisite failures do not count as RED.
- [x] **Step 4: Make the smallest source correction.** In the current pending selection return `MAX(outbox.created_at) AS last_output_at`, retain its existing filters/grouping/ordering/limit, and use the parsed timestamp in the existing age comparison. Keep the join/operation lineage and all stale-handling/evidence code unchanged. Do not add new abstractions or locking protocols.
- [x] **Step 5: Run GREEN and document.** Re-run the same focused files; all cases must pass with no ad-hoc waits. Update the processing runbook and report changed files, RED/GREEN evidence and any concern. No broad unit/mobile, native or mutation campaign is authorized to the worker.
- [ ] **Step 6: Lead review and publication.** Lead reviews the diff and focused results, obtains the required task/whole-change review, runs full lint and root/server/web typechecks plus relevant focused units, then commits and pushes immediately. No worker commit before lead review/pre-push checks; do not cherry-pick or merge another branch. Shared heavy checks need direct peer coordination. Reuse passing checks unless subsequent source changes or a real concern justify repeating them.

**Focused commands:**

```sh
rtk proxy pnpm vitest run --project unit src/processing/processing-reconciler.test.ts --maxWorkers 1
rtk proxy sh -c 'set -a; . ./.env.local; set +a; TEST_DATABASE_URL="$DATABASE_URL" pnpm vitest run --project integration src/processing/processing-reconciler.integration.test.ts --maxWorkers 1'
```

Prepare dependencies through `pnpm compose --` and the current testing guide/integration skill. Keep the plan ledger's test/check/review gates explicit. The lead owns production recovery approval after this change is reviewed and validated.
