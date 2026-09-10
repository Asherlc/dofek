# Dofek MCP Data Quality Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every MCP health/activity aggregate trustworthy, diagnosable, and coverage-aware while adding the requested training analytics.

**Architecture:** A shared server-side health-series builder becomes the canonical nullable-only, coverage-aware contract for `get_health_trends` and `render_health_explorer`. Ingest boundaries reject invalid metric values before persistence; raw provider records remain intact while daily serving models select one deterministic per-provider observation. Expensive training metrics are incremental dbt models over deduped ClickHouse sources and are exposed by focused repositories and MCP tools.

**Tech Stack:** TypeScript, Zod, Vitest, Drizzle/Postgres, ClickHouse, dbt incremental models, tRPC/MCP, Sentry.

**Spec:** `docs/superpowers/specs/2026-09-01-dofek-mcp-data-quality-design.md`

## Global Constraints

- Missing numeric observations serialize only as `null`; do not use zero, negative, or omitted-key sentinels.
- Compute all display metrics and coverage on the server; web and iOS only render the response.
- Preserve provider-attributed raw records. Daily serving models may select a canonical record but must retain per-source observations and provenance.
- Do not ingest, normalize, serve, analyze, or display provider/device calorie-expenditure estimates; remove the permanently-null MCP field.
- New ClickHouse analytics tables are dbt incremental models reading deduped sensor/activity sources.
- Write regression tests before production code and observe each test fail for the targeted behavior.
- Historical fetches/backfills are explicit, bounded TypeScript operations with dry-run default and `--execute`; never run them in migrations or request paths.
- Push every commit to the configured remote.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `packages/mcp-contracts/src/health-explorer.ts` | Shared health-series, coverage, and no-data schemas. |
| `packages/server/src/mcp/health-series-service.ts` | Nullable series construction, per-metric coverage, and trend diagnostics. |
| `packages/server/src/mcp/health-explorer-service.ts` | Explorer projection of the shared health-series result. |
| `packages/server/src/mcp/tools.ts` | MCP registration, activity summary contract, data coverage tool. |
| `src/db/metric-observation-validation.ts`, `src/db/daily-body-measurement.ts`, and `drizzle/0101_daily_body_measurement_identity.sql` | Validated metric/reject storage and daily body serving identity. |
| `src/db/daily-body-measurement.ts` | Deterministic daily source selection/upsert boundary. |
| `src/providers/apple-health/db-insertion.ts`, `src/providers/withings.ts`, `src/providers/bodyspec.ts`, and provider-client mapping modules | Per-provider raw type retention, range validation, and mappings. |
| `analytics/models/read_models/daily_body_measurement.sql`, `analytics/models/read_models/cycling_power_profile.sql`, and `analytics/models/read_models/daily_training_load.sql` | Incremental deduped body, cycling, and load serving models. |
| `packages/server/src/repositories/data-coverage-repository.ts`, `body-repository.ts`, `climbing-training-log-repository.ts`, `cycling-advanced-repository.ts`, and `pmc-repository.ts` | Focused read APIs for coverage, body reconciliation, climbing, cycling, and load. |
| `scripts/audit-mcp-data-quality.ts`, `scripts/backfill-provider-health-history.ts` | Production evidence report and bounded historical repair. |

### Task 1: Establish nullable health-series and coverage contracts

**Files:**
- Modify: `packages/mcp-contracts/src/health-explorer.ts`
- Test: `packages/mcp-contracts/src/health-explorer.test.ts`
- Create: `packages/server/src/mcp/health-series-service.ts`
- Test: `packages/server/src/mcp/health-series-service.test.ts`

**Interfaces:**
- Produces `HealthSeriesEnvelope`, used by both MCP health tools.

- [ ] **Step 1: Write failing contract and service tests**

```ts
expect(buildHealthSeries(fixtureRows, request)).toMatchObject({
  series: [{ metric: "hrv", points: [{ key: "2026-08-21", value: null }] }],
  diagnostics: { metrics_with_no_data: [] },
});
expect(result.coverage.by_metric.hrv).toEqual({
  observed_days: 28,
  missing_days: ["2026-08-21", "2026-08-23", "2026-08-30"],
  missing_days_truncated_count: 0,
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `rtk pnpm vitest run packages/mcp-contracts/src/health-explorer.test.ts packages/server/src/mcp/health-series-service.test.ts`

Expected: FAIL because `HealthSeriesEnvelope` and `buildHealthSeries` do not exist and global coverage is still required.

- [ ] **Step 3: Add the shared nullable-only types and builder**

```ts
export type MetricCoverage = {
  observed_days: number;
  missing_days: string[];
  missing_days_truncated_count: number;
};

export function buildHealthSeries(rows: HealthTrendRow[], input: HealthSeriesInput): HealthSeriesEnvelope {
  // emit every requested metric; use null for absent values; cap missing dates at 30
}
```

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run: `rtk pnpm vitest run packages/mcp-contracts/src/health-explorer.test.ts packages/server/src/mcp/health-series-service.test.ts`

Expected: PASS, including null-only missing values, capped missing dates, and summaries that skip nulls.

- [ ] **Step 5: Commit and push**

```bash
rtk git add packages/mcp-contracts/src/health-explorer.ts packages/mcp-contracts/src/health-explorer.test.ts packages/server/src/mcp/health-series-service.ts packages/server/src/mcp/health-series-service.test.ts
rtk git commit -m "fix: add coverage-aware health series"
rtk git push
```

### Task 2: Unify MCP health-trend and explorer behavior

**Files:**
- Modify: `packages/server/src/mcp/tools.ts`
- Modify: `packages/server/src/mcp/health-explorer-service.ts`
- Test: `packages/server/src/mcp/route.test.ts`
- Test: `packages/server/src/mcp/health-explorer-service.test.ts`

**Interfaces:**
- Consumes `buildHealthSeries()` from Task 1.
- Produces `{ range, requested_metrics, series, diagnostics }` from `get_health_trends` and explorer per-metric coverage.

- [ ] **Step 1: Write failing MCP regressions**

```ts
expect(parseToolCallText(response.text)).toMatchObject({
  requested_metrics: ["steps"],
  series: [{ metric: "steps", points: [], note: "no_data_in_range" }],
  diagnostics: { metrics_with_no_data: ["steps"], earliest_available: "2026-03-09" },
});
expect(explorer.summary.find((x) => x.metric === "sleep_efficiency")?.average).toBeGreaterThan(92);
```

- [ ] **Step 2: Run and verify RED**

Run: `rtk pnpm vitest run packages/server/src/mcp/route.test.ts packages/server/src/mcp/health-explorer-service.test.ts`

Expected: FAIL because trends returns an array, no-data metrics are omitted, and explorer has global coverage.

- [ ] **Step 3: Route both tools through the shared builder**

```ts
return jsonContent(await listHealthSeries(context, { start_date, end_date, metrics, granularity, timezone }));
// HealthExplorerService.snapshot() projects HealthSeriesEnvelope without recomputing values.
```

- [ ] **Step 4: Verify GREEN**

Run: `rtk pnpm vitest run packages/server/src/mcp/route.test.ts packages/server/src/mcp/health-explorer-service.test.ts`

Expected: PASS for 2026-08 sentinel dates, explicit no-data, clamping diagnostics, and nullable summaries.

- [ ] **Step 5: Commit and push**

```bash
rtk git add packages/server/src/mcp/tools.ts packages/server/src/mcp/health-explorer-service.ts packages/server/src/mcp/route.test.ts packages/server/src/mcp/health-explorer-service.test.ts
rtk git commit -m "fix: make MCP health gaps explicit"
rtk git push
```

### Task 3: Validate health/body observations at ingestion and audit rejects

**Files:**
- Modify: `src/db/metric-stream.ts`, `src/db/daily-metrics.ts`, and the barrel export that already exposes their writer contracts
- Create: `src/db/metric-observation-validation.ts`
- Test: `src/db/metric-observation-validation.test.ts`
- Modify: `src/providers/apple-health/db-insertion.ts`, `src/providers/withings.ts`, `src/providers/bodyspec.ts`, and `src/providers/oura/sync-steps.ts`
- Test: adjacent provider/import tests

**Interfaces:**
- Produces `validateMetricObservation({ providerId, date, metric, value }): ValidationResult`.

- [ ] **Step 1: Write failing validation tests**

```ts
expect(validateMetricObservation({ providerId: "apple_health", date: "2026-08-21", metric: "hrv", value: 0 })).toEqual({ accepted: false, reason: "must_be_positive" });
expect(validateMetricObservation({ providerId: "withings", date: "2026-05-14", metric: "weight_kg", value: -1 }).accepted).toBe(false);
expect(validateMetricObservation({ providerId: "oura", date: "2026-08-13", metric: "sleep_efficiency", value: 101 }).accepted).toBe(false);
```

- [ ] **Step 2: Run and verify RED**

Run: `rtk pnpm vitest run src/db/metric-observation-validation.test.ts`

Expected: FAIL because the validation module is absent.

- [ ] **Step 3: Implement validation and rejected-observation recording**

```ts
export function validateMetricObservation(input: MetricObservation): ValidationResult {
  if (["hrv", "resting_hr", "weight_kg"].includes(input.metric) && input.value <= 0) return rejected("must_be_positive");
  if (input.metric === "sleep_efficiency" && (input.value <= 0 || input.value > 100)) return rejected("outside_0_to_100");
  return { accepted: true };
}
```

Record rejects with provider/date/metric/value/reason, call `captureException()` for unexpected write errors, and pass only accepted observations to existing writers.

- [ ] **Step 4: Verify GREEN**

Run: `rtk pnpm vitest run src/db/metric-observation-validation.test.ts src/providers/apple-health/db-insertion.test.ts`

Expected: PASS; invalid values do not reach persistence and a provider/date audit row is produced.

- [ ] **Step 5: Commit and push**

```bash
rtk git add src/db/schema src/db/metric-observation-validation.ts src/db/metric-observation-validation.test.ts src/providers
rtk git commit -m "fix: reject invalid health observations at ingest"
rtk git push
```

### Task 4: Create canonical daily body observations and reconciliation

**Files:**
- Create: `src/db/daily-body-measurement.ts`
- Create: `src/db/daily-body-measurement.ts`
- Create: `src/db/daily-body-measurement.integration.test.ts`
- Create: `drizzle/0101_daily_body_measurement_identity.sql`
- Modify: `src/db/clickhouse-migrations/registry.ts`
- Create: `src/db/clickhouse-migrations/0073_daily_body_measurement.ts` and `analytics/models/read_models/daily_body_measurement.sql`
- Modify: `packages/server/src/repositories/body-clickhouse.ts`, `packages/server/src/repositories/body-repository.ts`
- Test: `packages/server/src/repositories/body-clickhouse.test.ts`

**Interfaces:**
- Produces `upsertDailyBodyObservation()` keyed by user/metric/local-date/provider and `ReconciledBodyMeasurement` with `sources` and `chosen_source`.

- [ ] **Step 1: Write failing integration and repository tests**

```ts
await insertRawMeasurements([weight("2026-05-14", "apple_health", 89.7, "10:00"), weight("2026-05-14", "apple_health", 90.0, "11:00")]);
expect(await listDailyBodyObservations()).toHaveLength(1);
expect((await listDailyBodyObservations())[0]).toMatchObject({ value: 90.0, chosen_source: "apple_health" });
```

- [ ] **Step 2: Run and verify RED**

Run: `rtk pnpm test:integration -- src/db/daily-body-measurement.integration.test.ts && rtk pnpm vitest run packages/server/src/repositories/body-clickhouse.test.ts`

Expected: FAIL because raw duplicates are returned and no daily serving identity exists.

- [ ] **Step 3: Implement deterministic daily projection and migration**

```sql
ROW_NUMBER() OVER (
  PARTITION BY user_id, metric, local_date, source_provider
  ORDER BY ingested_at DESC, non_null_field_count DESC, id DESC
) = 1
```

Keep raw `body_measurements` append-only. Apply the unique key to the daily-grain serving table, upsert that table from writers, expose per-source values and server-selected reconciliation, and refresh its ClickHouse incremental projection.

- [ ] **Step 4: Verify GREEN**

Run: `rtk pnpm test:integration -- src/db/daily-body-measurement.integration.test.ts && rtk pnpm vitest run packages/server/src/repositories/body-clickhouse.test.ts && rtk pnpm lint:analytics-policy`

Expected: PASS; one value exists per provider/day/metric, newest ingest wins, and source provenance remains visible.

- [ ] **Step 5: Commit and push**

```bash
rtk git add src/db drizzle analytics packages/server/src/repositories
rtk git commit -m "fix: reconcile daily body measurements"
rtk git push
```

### Task 5: Retain raw activity types and reduce unclassified activity coverage

**Files:**
- Modify: `src/db/schema/activity.ts`, activity provider sync helpers, and ClickHouse activity projection
- Modify: provider mapping modules discovered by the raw-type audit
- Test: adjacent provider parser tests and `packages/server/src/mcp/route.test.ts`
- Create: `scripts/audit-mcp-data-quality.ts`
- Test: `scripts/audit-mcp-data-quality.test.ts`

**Interfaces:**
- Produces activity `{ canonical_type, raw_type }` and `get_activity_summary(...).unclassified_pct`.

- [ ] **Step 1: Write failing mapper and MCP tests**

```ts
expect(mapConnectActivityType("bouldering")).toMatchObject({ canonicalType: "climbing", rawType: "bouldering" });
expect(activitySummary).toMatchObject({ unclassified_pct: 4.2 });
expect(activityDetail.raw_type).toBe("hangboard");
```

- [ ] **Step 2: Run and verify RED**

Run: `rtk pnpm vitest run packages/garmin-connect/src/parsing.test.ts packages/server/src/mcp/route.test.ts scripts/audit-mcp-data-quality.test.ts`

Expected: FAIL because raw type is not persisted, mappings produce `other`, and the summary has no coverage percentage.

- [ ] **Step 3: Implement isolated mappings and the audit report**

```sql
SELECT provider_id, raw_type, count(*) AS activities, sum(duration_seconds) / 60 AS minutes
FROM analytics.activity_summary
WHERE canonical_type = 'other' AND started_at >= {start:DateTime}
GROUP BY 1, 2 ORDER BY activities DESC, minutes DESC
```

Add raw type on every provider's activity input; map the exact audit head (climbing disciplines, fingerboard, strength, walking, hiking, HIIT/functional/cardio, paddling/kayaking, running) in each provider module; calculate `100 * other / total` server-side. Remove `total_calories` from activity schemas and tool output.

- [ ] **Step 4: Verify GREEN**

Run: `rtk pnpm vitest run packages/garmin-connect/src/parsing.test.ts packages/server/src/mcp/route.test.ts scripts/audit-mcp-data-quality.test.ts`

Expected: PASS; supplied 2026 fixture has `< 10` percent `other`, and all activities retain raw type.

- [ ] **Step 5: Commit and push**

```bash
rtk git add src/db src/providers packages packages/server/src/mcp scripts
rtk git commit -m "fix: expose and classify raw activity types"
rtk git push
```

### Task 6: Add coverage inventory and investigate historic gaps

**Files:**
- Create: `packages/server/src/repositories/data-coverage-repository.ts`
- Test: `packages/server/src/repositories/data-coverage-repository.test.ts`
- Modify: `packages/server/src/mcp/tools.ts`, `packages/server/src/mcp/route.test.ts`
- Modify: `scripts/audit-mcp-data-quality.ts`

**Interfaces:**
- Produces `DataCoverageRow { metric, first_observed, last_observed, total_days_observed, source_providers }`.

- [ ] **Step 1: Write failing coverage and dated-gap tests**

```ts
expect(await repository.list()).toContainEqual({ metric: "resting_hr", first_observed: "2026-03-09", last_observed: "2026-09-01", total_days_observed: 170, source_providers: ["apple_health"] });
expect(parseToolCallText(response.text)).toEqual(expect.arrayContaining([expect.objectContaining({ metric: "hrv" })]));
```

- [ ] **Step 2: Run and verify RED**

Run: `rtk pnpm vitest run packages/server/src/repositories/data-coverage-repository.test.ts packages/server/src/mcp/route.test.ts`

Expected: FAIL because the repository and `get_data_coverage` tool do not exist.

- [ ] **Step 3: Implement source-aware inventory and audit commands**

```ts
export interface DataCoverageRow {
  metric: string; first_observed: string | null; last_observed: string | null;
  total_days_observed: number; source_providers: string[];
}
```

Query canonical daily values and deduped sensor read models, count non-null local dates only, and include the 2022 cycling raw-power and 2023 HR/sleep boundary evidence in the audit command output.

- [ ] **Step 4: Verify GREEN**

Run: `rtk pnpm vitest run packages/server/src/repositories/data-coverage-repository.test.ts packages/server/src/mcp/route.test.ts`

Expected: PASS; no-data and out-of-range requests are distinguishable and coverage has provider provenance.

- [ ] **Step 5: Commit and push**

```bash
rtk git add packages/server/src/repositories/data-coverage-repository.ts packages/server/src/repositories/data-coverage-repository.test.ts packages/server/src/mcp/tools.ts packages/server/src/mcp/route.test.ts scripts/audit-mcp-data-quality.ts
rtk git commit -m "feat: expose MCP data coverage"
rtk git push
```

### Task 7: Repair backed historical fields only after evidence confirms them

**Files:**
- Create: `scripts/backfill-provider-health-history.ts`
- Test: `scripts/backfill-provider-health-history.test.ts`
- Create: `docs/provider-health-history-backfill-runbook.md`
- Modify: `package.json`

**Interfaces:**
- Produces `pnpm backfill:provider-health-history --provider <id> --start <date> --end <date> [--execute]`.

- [ ] **Step 1: Write failing parser and dry-run tests**

```ts
await main(["--provider", "garmin", "--start", "2022-01-01", "--end", "2022-12-31"]);
expect(sync).not.toHaveBeenCalled();
await main(["--provider", "garmin", "--start", "2022-01-01", "--end", "2022-12-31", "--execute"]);
expect(sync).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: expect.any(String) }));
```

- [ ] **Step 2: Run and verify RED**

Run: `rtk pnpm vitest run scripts/backfill-provider-health-history.test.ts`

Expected: FAIL because the bounded backfill command does not exist.

- [ ] **Step 3: Implement bounded command and runbook**

Use the established `--execute` parser pattern. Resolve one user/provider/date range; print source availability, eligible records, and exact expected writes in dry-run mode. On execution, checkpoint completed date pages and call only the existing idempotent ingestion boundary. Document required audit evidence, dry-run review, execute command, and post-backfill validation queries.

- [ ] **Step 4: Verify GREEN and perform authorized production sequence**

Run: `rtk pnpm vitest run scripts/backfill-provider-health-history.test.ts`

Then run the audit command and dry run against the authorized production user. Only if it proves upstream fields exist, run the same bounded command with `--execute`, then re-run coverage and 2022-power queries.

Expected: tests pass; production writes occur only for source-backed values and post-run counts match dry-run output.

- [ ] **Step 5: Commit and push**

```bash
rtk git add scripts/backfill-provider-health-history.ts scripts/backfill-provider-health-history.test.ts docs/provider-health-history-backfill-runbook.md package.json
rtk git commit -m "feat: add bounded provider history backfill"
rtk git push
```

### Task 8: Expose climbing and hangboard session instrumentation

**Files:**
- Modify: `src/db/schema/activity.ts`
- Modify: `src/providers/kaya/import.ts`, `src/providers/kaya/provider.ts`, and `src/providers/apple-health/workouts.ts`
- Modify: `packages/server/src/repositories/climbing-training-log-repository.ts`, `packages/server/src/mcp/tools.ts`
- Test: repository tests and `packages/server/src/mcp/route.test.ts`

**Interfaces:**
- Produces `ClimbingSessionDetail` and `HangboardSessionDetail`; `get_finger_loading` returns `{ effective_load, inputs, formula }`.

- [ ] **Step 1: Write failing session-detail tests**

```ts
expect(fingerLoading).toMatchObject({ inputs: { edge_depth_mm: 20, added_load_kg: 10, hang_seconds: 7 }, formula: expect.stringContaining("time_under_tension") });
expect(climbing).toMatchObject({ discipline: "boulder", grade_distribution: [{ grade: "V5", sends: 3, attempts: 5 }], vertical_m: 42 });
```

- [ ] **Step 2: Run and verify RED**

Run: `rtk pnpm vitest run packages/server/src/mcp/route.test.ts packages/server/src/repositories/climbing-training-log-repository.test.ts`

Expected: FAIL because only opaque effective load or HR/duration is returned.

- [ ] **Step 3: Map raw provider fields without fabrication**

Persist only present raw climbing/hangboard fields; return null for unavailable fields. Group grades/sends/attempts server-side and expose the existing finger-loading input terms and exact formula label.

- [ ] **Step 4: Verify GREEN**

Run: `rtk pnpm vitest run packages/server/src/mcp/route.test.ts packages/server/src/repositories/climbing-training-log-repository.test.ts`

Expected: PASS; session detail preserves missing fields as null and never invents measurements.

- [ ] **Step 5: Commit and push**

```bash
rtk git add src/db src/providers packages/server/src/repositories/climbing-training-log-repository.ts packages/server/src/mcp/tools.ts packages/server/src/mcp/route.test.ts
rtk git commit -m "feat: expose climbing and hangboard session data"
rtk git push
```

### Task 9: Add deduped cycling fitness and workload read models

**Files:**
- Create: `analytics/models/read_models/cycling_power_profile.sql`
- Create: `analytics/models/read_models/daily_training_load.sql`
- Create: matching dbt SQL tests
- Create: `src/db/clickhouse-migrations/0074_cycling_power_and_training_load.ts` and modify `src/db/clickhouse-migrations/registry.ts`
- Modify: `packages/server/src/repositories/cycling-advanced-repository.ts`, `packages/server/src/repositories/pmc-repository.ts`
- Test: adjacent repository tests and `packages/server/src/routers/cycling-activity-read-model.integration.test.ts`

**Interfaces:**
- Produces per-ride `{ normalized_power_w, intensity_factor, mmp_5s_w, mmp_1m_w, mmp_5m_w, mmp_20m_w, elevation_gain_m }`, rolling 90-day bests, estimated FTP, and `{ acute_7d, chronic_28d, ratio }`.

- [ ] **Step 1: Write failing executable read-model tests**

```ts
expect(await cyclingRepository.profile("ride-1")).toMatchObject({ normalizedPowerW: 250, intensityFactor: 0.91, mmp20mW: 265, elevationGainM: 410 });
expect(await loadRepository.window("2026-09-01")).toEqual({ acute7d: 420, chronic28d: 1_400, ratio: 1.2 });
```

- [ ] **Step 2: Run and verify RED**

Run: `rtk pnpm test:integration -- packages/server/src/routers/cycling-activity-read-model.integration.test.ts`

Expected: FAIL because the new serving tables and repository fields do not exist.

- [ ] **Step 3: Implement incremental dbt models over deduped inputs**

`cycling_power_profile` reads only deduped sensor/activity records, computes rolling power terms per activity and local date, and writes one row per activity. `daily_training_load` uses power-derived load when power exists and HR-based TRIMP otherwise, then derives 7/28-day windows in the repository. Never compute these values in a client or request-time raw sensor scan.

- [ ] **Step 4: Verify GREEN**

Run: `rtk pnpm analytics:build && rtk pnpm lint:analytics-sql && rtk pnpm lint:analytics-policy && rtk pnpm test:integration -- packages/server/src/routers/cycling-activity-read-model.integration.test.ts`

Expected: PASS; models are incremental, deduped, and fixtures prove power and HR fallback paths.

- [ ] **Step 5: Commit and push**

```bash
rtk git add analytics src/db/clickhouse-migrations packages/server/src/repositories packages/server/src/routers
rtk git commit -m "feat: add cycling power and training load analytics"
rtk git push
```

### Task 10: Full verification and operational evidence

**Files:**
- Modify: `docs/mcp.md`, `docs/provider-health-history-backfill-runbook.md`
- Modify: `docs/production-incident-baseline.md` only if production investigation finds an incident/deploy/infra failure.

- [ ] **Step 1: Add the five supplied acceptance fixtures to MCP tests**

```ts
// 2026-08 explorer: no zero HRV/sleep efficiency; average 92..94; coverage 28.
// 2026 activity summary: other < 10 and unclassified_pct present.
// 2023 trends: structured no-data diagnostics, never [].
// 2026-05 body: one canonical row per provider/local date.
// data coverage: first/last/total/provider list for every metric.
```

- [ ] **Step 2: Run focused acceptance verification**

Run: `rtk pnpm vitest run packages/server/src/mcp/route.test.ts packages/server/src/mcp/health-series-service.test.ts packages/server/src/repositories/data-coverage-repository.test.ts`

Expected: PASS with all five named acceptance cases.

- [ ] **Step 3: Run database and analytics verification**

Run: `rtk pnpm test:integration -- src/db/daily-body-measurement.integration.test.ts packages/server/src/routers/cycling-activity-read-model.integration.test.ts && rtk pnpm lint:analytics-policy && rtk pnpm lint:migrations`

Expected: PASS, with no duplicate canonical daily body observations.

- [ ] **Step 4: Run repository-wide quality gates**

Run: `rtk pnpm lint && rtk pnpm typecheck && rtk pnpm test:changed:all`

Expected: exit 0 for each command.

- [ ] **Step 5: Commit documentation and push**

```bash
rtk git add docs
rtk git commit -m "docs: document MCP data coverage operations"
rtk git push
```

## Plan Self-Review

- Spec coverage: Tasks 1–2 cover sentinel/null, per-metric coverage, no-data envelopes, and explorer regression dates. Tasks 3–4 cover ingest validation and body source reconciliation. Tasks 5–7 cover mapping, dead metrics, power/history investigation, data coverage, and bounded backfill. Tasks 8–9 cover climbing/hangboard, cycling, and workload. Task 10 verifies every supplied acceptance command.
- Placeholder scan: no task uses deferred implementation language; each code/test step names a concrete interface, command, and expected outcome.
- Type consistency: `HealthSeriesEnvelope`, `DataCoverageRow`, `ReconciledBodyMeasurement`, `ClimbingSessionDetail`, and cycling/load response fields are defined at their producer tasks before consumer tasks.
