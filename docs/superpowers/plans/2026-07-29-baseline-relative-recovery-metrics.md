# Baseline-Relative Recovery Metrics TDD Plan

> **Test-first workflow:** Write each failing test before its production change.

**Goal:** Expose trustworthy baseline-relative context for the recovery metric set through one server-owned computation shared by tRPC, MCP, web, and mobile.

**Behavior:** Each supported daily recovery metric—Heart Rate Variability (HRV), resting heart rate, respiratory rate, and sleep efficiency—returns its current value together with the mean and population standard deviation from the preceding 30 calendar days, current z-score, sample count, calendar coverage, and the difference between the latest 7-day mean and preceding 28-day mean. The current day is excluded from its own baseline. A mean is available with at least one sample; standard deviation and z-score require at least two samples and a nonzero standard deviation. Sparse results remain visible and are qualified by count and coverage instead of being hidden behind an arbitrary threshold.

**Scope:** Issue [#2248](https://github.com/Asherlc/dofek/issues/2248), limited to the explicitly requested first recovery slice. Body weight and training load are non-goals for this slice. No derived value is stored in Postgres, and clients only format and render server-computed values.

**Performance decision:** Extend the existing dbt-owned incremental `analytics.daily_recovery_inputs` and `analytics.daily_recovery` models rather than adding request-time rolling calculations. The [2026-06-04 slow-query evidence](../../production-incident-baseline.md#2026-06-04-slow-query-audit-dashboard-read-model-follow-up) recorded recovery/health request paths taking roughly 45–71 seconds and identified repeated request-time rolling windows as the cause; those models are already the compact serving path introduced by that investigation. This follows the [loading-performance backend gate](../../performance/loading-performance-runbook.md#backend-and-analytics-gate).

---

## Current Evidence

- `analytics/models/read_models/daily_recovery_inputs.sql` already computes 30-day and 60-day HRV, resting-heart-rate, and respiratory-rate statistics, but its `ROWS` frames count observations rather than calendar days, include the current day, and omit sample coverage and 7-versus-28-day context.
- `analytics/models/read_models/daily_recovery.sql` already consumes those inputs for readiness z-scores, while `packages/server/src/services/mobile-recovery-tab.ts`, `packages/server/src/services/health-status.ts`, and anomaly code recompute overlapping baseline semantics in TypeScript or Postgres.
- `packages/server/src/mcp/tools.ts#get_health_trends` currently returns only raw daily/weekly min, max, and average values.
- Web already renders a partial health-status deviation, but it is based on the selected request range. Mobile standalone HRV and resting-heart-rate cards show a client-selected 7-day average rather than the canonical server baseline.

## Test Strategy

- Statistics/read model unit policy: assert the dbt SQL uses prior calendar-day windows, emits count/coverage and 7/28 means, and carries the canonical fields into `daily_recovery`.
- Executable ClickHouse integration: seed sparse, boundary, zero-variance, and complete fixtures; execute both dbt model selects; prove current-day exclusion, calendar-gap handling, mean/standard-deviation availability, z-score, count/coverage, 7/28 delta, incremental replacement, and deletion behavior.
- Server unit/integration: prove one repository contract maps the four recovery metrics, tRPC returns it, mobile dashboard reuses it for health status/readiness, and MCP daily/weekly trends include it.
- UI parity: prove web health status and mobile standalone recovery cards render server-provided standard-deviation deviation, direction, 7/28 delta, and sparse coverage without client-side statistics.
- Stories: update the modified web and mobile component/screen stories with default, loading, empty/no-data, complete, sparse, unavailable, and directional examples.

## File Structure

- Modify `analytics/models/read_models/daily_recovery_inputs.sql` and `daily_recovery.sql` — canonical calendar-window statistics.
- Modify `analytics/models/read_models/read_model_microbatch.sql.test.ts` and `packages/server/src/services/daily-recovery-read-model.integration.test.ts` — SQL policy and executable ClickHouse behavior.
- Create `src/db/clickhouse-migrations/0062_daily_recovery_baseline_context.ts` and its test; modify `registry.ts` — durable serving-table columns.
- Modify `packages/server/src/routers/clickhouse-integration-test-models.ts` — current test schema.
- Create `packages/server/src/contracts/baseline-relative-metrics.ts` and its colocated test — shared output schema and metric/direction vocabulary.
- Create `packages/server/src/repositories/recovery-baseline-repository.ts` and its colocated test — one query/mapping path over `analytics.daily_recovery`.
- Modify daily-metrics/mobile-dashboard contracts, routers, services, and focused tests — tRPC/mobile reuse and removal of overlapping recovery-set calculations.
- Modify `packages/server/src/mcp/tools.ts`, MCP tests, and `docs/mcp.md` — baseline-relative MCP output.
- Modify web health-status rendering/tests/stories and mobile recovery rendering/tests/stories — dual-platform presentation.

## Tasks

### Task 1: Pin the Canonical Read-Model Semantics

- [ ] Add failing SQL policy assertions for prior calendar-day frames, current-day exclusion, sample counts, coverage, 7-day and preceding-28-day means, deltas, and direction inputs.
- [ ] Add failing executable ClickHouse fixtures for a complete window, sparse dates, exactly one/two samples, zero variance, and data on the current day.
- [ ] Run `rtk pnpm test:unit -- analytics/models/read_models/read_model_microbatch.sql.test.ts` and confirm the policy tests fail for the missing fields.
- [ ] Run `rtk pnpm test:integration -- packages/server/src/services/daily-recovery-read-model.integration.test.ts` and confirm the behavioral assertions fail for the current model.

### Task 2: Implement the Read Model and Durable Schema

- [ ] Add the serving-table columns through a forward ClickHouse migration and update the current integration-test schema.
- [ ] Change the dbt models to compute the four recovery metrics from the preceding calendar windows and carry the canonical fields through `daily_recovery`.
- [ ] Preserve incremental changed-row and tombstone behavior.
- [ ] Re-run the focused policy and ClickHouse integration tests and confirm they pass.

### Task 3: Add One Server Contract and Migrate Consumers

- [ ] Add failing schema/builder tests for four metrics, sparse coverage, unavailable standard deviation/z-score, signed delta, and direction.
- [ ] Add failing repository tests proving one compact `daily_recovery FINAL` query returns the canonical response.
- [ ] Add failing tRPC, mobile-dashboard, and MCP tests for the extended response shape and daily/weekly behavior.
- [ ] Implement the minimum repository/contract changes and migrate recovery health status/readiness consumers to the canonical fields.
- [ ] Re-run all focused server and MCP tests and confirm they pass.

### Task 4: Render Server-Owned Context on Web and Mobile

- [ ] Add failing web tests showing deviation, 7/28 direction, and coverage in the health-status surface.
- [ ] Add failing mobile tests showing the same context beside standalone HRV, resting-heart-rate, respiratory-rate, and sleep-efficiency values.
- [ ] Implement formatting/rendering only; do not calculate statistics in either client.
- [ ] Update the colocated web stories and mobile recovery stories for default, loading, empty/no-data, sparse, unavailable, improving, and declining variants.
- [ ] Run the focused web and mobile tests and confirm they pass.

### Task 5: Final Verification and Delivery

- [ ] Run `rtk pnpm lint`.
- [ ] Run `rtk pnpm tsc --noEmit`, `rtk pnpm --dir packages/server tsc --noEmit`, and `rtk pnpm --dir packages/web tsc --noEmit`.
- [ ] Run `rtk pnpm test:unit`, `rtk pnpm test:mobile`, and the focused ClickHouse integration test.
- [ ] Run `rtk pnpm test:changed:all`.
- [ ] Review the complete diff for server-side computation, dual-platform parity, schema consistency, and scope.
- [ ] Commit and push each meaningful change, open a PR with `Fixes #2248`, backlink the issue, monitor required checks/reviews, address feedback, and squash-merge only after all requirements pass.
