# Analytics build work reuse implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Reduce measured analytics scan work under the existing publication owner so sink consumption can exceed arrivals.

**Architecture:** Reuse two activity-level computations within their existing dbt queries: the current canonical activity result and the VO2 max dirty-key set. Use ClickHouse's stock query-local materialized CTE capability already used elsewhere in this project; do not introduce persisted state, a scheduler or a different lock. Native regressions establish baseline read amplification before runtime SQL changes and require fewer reads with unchanged row semantics afterward.

**Tech Stack:** Existing dbt/ClickHouse 26.6.1.1193, TypeScript/Vitest integration fixtures, existing Zod and ClickHouse client.

**Spec:** The operator explicitly approved profiling and reducing measured analytics build work under the existing publication lock, using current dbt models and correctness/performance tests, then shipping after CI. The binding constraints below reproduce that direction. No separate design document is needed for these two query-local changes.

## Evidence and selected boundaries

After batching release `6b740c88d`, live consumption remained below arrivals: from 16:32:20 to 17:10:29 UTC, 25,765 records were consumed and 54,931 arrived. PostgreSQL identified the analytics owner holding the shared publication resource while both sinks waited; completed batch durations reached about 707 seconds. No abandoned-owner recovery is indicated.

Native query logs since 16:30 show three `deduped_activities` writes reading 725,294,684 rows (165,766 ms total) and three `activity_vo2max_estimate` writes reading 454,524,959 rows (131,404 ms total). Physical `deduped_sensor` rows were 118,674,815. A non-executing EXPLAIN of the current compiled canonical-activity SELECT shows two sensor reads, 22 activity-source reads and 40 field-priority reads. These counts describe work, not a promised production speedup.

`scoped_current_deduped_activities` is directly reused by both the current-output and stale-row branches; it contains canonical activity rows, including existing provenance, rather than raw sensor samples. VO2 `dirty_keys` is directly reused by activity bounds, dirty users and stale reconciliation, and contains only user/activity UUID pairs. A preview marking only `best` materialized did not reduce plan reads; that CTE has one direct reference and is not the selected boundary. ClickHouse documents [CTE inlining, reuse, automatic single-reference inlining and the required setting](https://clickhouse.com/docs/reference/statements/select/with#materialized-common-table-expressions).

Materialization is experimental in the pinned engine and must be enabled explicitly. It trades temporary memory for eliminated repeated computation; native read counts, result correctness and memory observations are mandatory. Do not materialize raw sensor/point streams or silently change bounds. Production query/memory and whole-cycle drain remain release qualification, not inferred from a small fixture.

Production-engine qualification found that 26.6 copies the materialized CTE into each final UNION branch and then inlines the separate single-use copies. The [upstream cross-UNION fix](https://github.com/ClickHouse/ClickHouse/pull/102107) starts in 26.7. A read-only plan of the actual compiled 26.6 query confirmed no materialization and two sensor reads with the marker alone. Nesting the unchanged final UNION under a parent SELECT that owns the WITH scope produced one shared materialization and one sensor read. Qualify this scope placement through the same native result/read/memory tests; retain the existing engine.

## Global Constraints

- The user reauthorized local Docker on November 13. Reuse the existing workspace Compose services for local native RED/GREEN and retain GitHub CI qualification on the production engine. Do not add a workflow, runner, alternate engine, retry or timeout.
- Keep the existing branch/workspace; no branch switch/rebase. Lead owns commits, automatic pushes, PR/CI and releases. Workers do not recursively delegate or take production actions.
- Preserve the shared owner, ingestion reservations, erasure fences, synchronous terminal proof and processing-success/cache gates. No pause, replica, offset, owner, schedule, batch-size, lookback, formula or retention changes.
- Runtime edits are limited to qualified model CTE declarations, their model-local `enable_materialized_cte: 1` context, and the canonical final SELECT scope needed to share that CTE on 26.6. Preserve branch bodies, output order/types, and existing optimizer/thread/null-join settings. No new stored table, projection, dependency or abstraction.
- Preserve canonical group/member identity, representative and origin selection, source priorities, names/provenance, scoped current/prior membership, lifecycle clocks, unchanged-output suppression and disappearance tombstones.
- Preserve VO2 dirty-source invalidation, source-time bounds, user/activity joins, scope expansion, methods/formulas, missing-data behavior and tombstones.
- Use existing current-schema fixtures/helpers; do not run historical migrations/backfills in tests, mock a database engine or add SQL-string tests as semantic evidence.
- Each touched TypeScript file stays at or below 1,000 physical lines. Extend existing helpers only when needed; no baseline source copies or maintained SQL rewriting harness.

## Review Focus

- Nonempty prior state must exercise both current and stale reconciliation, not let an empty target prune the expensive branch.
- Dense unrelated sensor rows make physical repeated discovery visible while exact representative/estimate rows remain asserted.
- First/incremental and scoped/unscoped paths retain old results, deletion/revival and clocks; existing native suites remain mandatory.
- Feature context must match the real model settings, not work only in a privileged test context.
- Native QueryFinish coverage must be nonempty and exact, and read bounds must fail for the evidenced work amplification before the fix.

### Task 1: Add the canonical native work regression before runtime changes

**Files:** `src/db/deduped-activities-read-model.integration.test.ts` and its existing `src/db/deduped-activities-test-helpers.ts`. Do not edit VO2 yet.

**Interfaces:** Reuse the canonical seeder/renderer and the existing real-dbt `runDbtBatch` helper from `activity-payload-dbt-microbatch-test-helpers.ts`. Its existing source-schema environment overrides and private project support this isolated fixture; do not add a runner or settings parser. The measured operation must use the actual canonical dbt model/config, not only a hand-rendered SELECT.

- [ ] Prepare scoped and unscoped cases with 8,192 dense linked samples and populated prior state. Clear the seeder's pre-existing WHOOP sample before writing/asserting the prior Peloton representative. Add a genuinely live prior-only group, then insert WHOOP samples at distinct fractional second replacement keys inside the one-hour bounds. Assert the surviving dense sample count under FINAL. Scoped inputs explicitly include the stale group and the correct fixture user.
- [ ] Seed the prior row through the existing renderer; measure the subsequent actual dbt append using `runDbtBatch` with only `deduped_activities`, existing valid day bounds, source-schema overrides and the explicit fixture user. Create only necessary fixture source aliases (the existing helper calls the activity source `source_activity`; dbt expects `activity`). Reuse the existing real-dbt integration timeout, not a larger/global limit. If the existing helper cannot execute this model faithfully, report the concrete gap before introducing machinery.
- [ ] Assert the exact live group/WHOOP representative/provider and real prior-only tombstone before the work assertion. Existing native cases continue to cover display/origin, lifecycle, revival and unchanged clocks.
- [ ] Capture a server timestamp before the measured invocation, flush CI query logs afterward and fetch all initial QueryFinish records for the actual model INSERT into the unique fixture target after that boundary. Require exactly one (no LIMIT), retain its query ID and validate positive metrics. Use the existing `readDbtStatementTarget` helper if operation/target matching is needed. Assert that actual raw-work accounting includes at least the 8,192 required source rows before requiring `read_rows <= 8192 * 1.5 + 1024`. Record rows/bytes, duration, memory and relevant effective settings before the work assertion. A light copy/metadata statement, missing child accounting, setup failure or schema error is not RED or GREEN.
- [ ] Add `enable_materialized_cte=1` to the existing hand-renderer context for existing native cases. The real-dbt RED run retains the original model's feature context; GREEN must obtain enablement from the model's own config. This intentional functional change is part of the fix; thread, null-join, memory and optimizer limits remain unchanged.
- [ ] Run Docker-free root TypeScript, changed-file Biome, configured spelling and diff checks. Lead runs the focused native regression on existing workspace services, reviews and commits/pushes; retain valid native RED before runtime correction and production-engine CI qualification before merge. Keep the canonical test file below 1,000 lines by putting necessary setup/metric plumbing in its existing helper, not by compressing unrelated cases.

**Gated VO2 candidate:** The plan review found that its hand renderer forces `join_use_nulls=1`, while production query-log entries do not record that setting; the same production default user reports `join_use_nulls=false`. This does not yet qualify production tombstone behavior. Keep VO2 source and tests unchanged until the actual dbt context is established with executable evidence. Do not silently add a null-join runtime setting under a performance change. Any later VO2 fixture must use genuinely live prior-only estimates, isolate sensor-only invalidation above the actual target watermark without sleeps, mirror the existing 100,000 optimization limit and pass genuine per-model native RED. Its previous 36,864-row budget is provisional, not a permission to manufacture a failure.

### Task 2: Reuse the two measured activity-level computations

**Files:** `analytics/models/read_models/deduped_activities.sql` and `analytics/models/read_models/activity_vo2max_estimate.sql`; only necessary existing helper context adjustments from Task 1.

**Interfaces:** Consume Task 1's actual native read/row evidence; produce identical model rows with less repeated work.

- [ ] Start only after the lead supplies valid native RED evidence for the model being changed. For a model without that evidence, keep its runtime SQL unchanged and report the gate.
- [ ] Mark only `scoped_current_deduped_activities AS MATERIALIZED` in the canonical model and only `dirty_keys AS MATERIALIZED` in VO2. Set `enable_materialized_cte: 1` in each changed model's existing query settings. Keep all query bodies, filters, order, joins and outputs unchanged.
- [ ] For the canonical model, place the unchanged final current/stale UNION inside `SELECT * FROM (...)` beneath the owning WITH scope. The pinned-engine plan must share the existing materialized result; native first-build, scoped/unscoped, lifecycle, read and memory gates must pass. Do not change branch bodies or add forcing settings.
- [ ] Run schema-aware/static policy checks that are Docker-free and changed-file checks. SQLFluff and executable database validation may run on existing local services; production-engine qualification remains in existing CI. No optimizer forcing, larger limits, retry or timeout workaround.
- [ ] Lead pushes and obtains native GREEN on the production engine for new and existing relevant cases, plus required repository CI. Report measured read reduction and memory for each fixture; do not infer production throughput from those numbers. If reuse is ignored or memory/result gates fail, diagnose within this strategy before any alternative approach.
- [ ] Explicitly assess RED/GREEN memory against unchanged limits and production headroom; reject unexplained/material growth or memory failures before approval. The observed production maximum is context, not permission for extra memory. A small synthetic fixture cannot establish production capacity; retain the rollout memory gate.

### Task 3: Review, ship and verify actual drain

**Owner:** Lead, with independent spec/quality review.

- [ ] Review complete source/test/docs diff and native receipts; resolve findings, then require final-commit CI and actionable PR feedback checks.
- [ ] Update the incident baseline with source evidence, exact failure/RED, direct correction and known limits. Preserve unrelated incident edits. Automatically push every new commit.
- [ ] Merge after CI; use only the canonical release, observing the separately merged drain-check release and existing deployment serialization. Verify actual source/digest, replica health, analytics success and fresh consumer commits afterward.
- [ ] Compare whole analytics cycles, query read/memory metrics and committed/end deltas with ongoing arrivals. Continue the read-only heartbeat to its original expiry; zero lag requires two healthy observations in both nonempty sink groups. Do not promise a catch-up ETA or mark adequate throughput from startup bursts or arrival-free windows.
