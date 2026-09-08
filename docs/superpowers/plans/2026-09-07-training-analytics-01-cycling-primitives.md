# Cycling Sensor Primitives Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add provenance-preserving activity time-series access and accurate server-side cycling power-duration curves, including arbitrary durations and evidence-backed W/kg.

**Architecture:** Extend the existing deduped ClickHouse sensor path instead of creating a second source of truth. Keep standard power durations in the incremental dbt model, execute bounded custom durations in ClickHouse, and expose both through small MCP repositories and tool modules. Keep the legacy stream and cycling tools unchanged.

**Tech Stack:** TypeScript, Zod, MCP SDK, Drizzle/PostgreSQL activity identity, ClickHouse 26.3, dbt incremental models, Vitest.

**Spec:** [Longitudinal training analysis design](../specs/2026-09-07-longitudinal-training-analysis-design.md)

## Global Constraints

- Read activity sensor data only from `analytics.deduped_sensor`, `analytics.deduped_activities`, `analytics.activity_sensor_sample`, and derived deduped read models.
- Preserve measured zero; represent missing values as `null`; label interpolation and aggregation explicitly.
- Raw activity pages default to 500 synchronized timestamps and never exceed 2,000.
- Fixed resolutions are exactly 1, 5, 10, 30, or 60 seconds; custom power requests accept at most 32 durations from 1 through 21,600 seconds.
- Default power durations are 1, 5, 15, 30, 60, 120, 300, 600, 720, 1,200, 1,800, 2,400, 3,600, and 5,400 seconds.
- A one-second best is unavailable when source resolution cannot support it; windows crossing a gap greater than `max(5 seconds, 2 * median positive sample interval)` are invalid.
- W/kg weight selection is same local day, then interpolation with measurements at most 14 days on both sides, then nearest within 30 days with earlier measurement winning a tie.
- Do not introduce a new environment variable or dependency.
- Every production behavior starts with a failing test, and database semantics use executable ClickHouse integration tests.
- Preserve all existing MCP tool names and response shapes.

---

### Task 1: Analytical evidence and cursor contracts

**Files:**

- Create: `packages/server/src/mcp/analytical-evidence.ts`
- Create: `packages/server/src/mcp/analytical-evidence.test.ts`
- Create: `packages/server/src/mcp/analytical-cursor.ts`
- Create: `packages/server/src/mcp/analytical-cursor.test.ts`

**Interfaces:**

- Consumes: Node `Buffer` and Zod already present in the server package.
- Produces:

```ts
export const epistemicKindSchema: z.ZodEnum<[
  "measured", "provider_recorded", "aggregated", "calculated",
  "estimated", "interpolated", "inferred", "unknown",
]>;
export const sourceReferenceSchema: z.ZodObject<{
  provider_id: z.ZodString;
  device_id: z.ZodNullable<z.ZodString>;
  source_type: z.ZodNullable<z.ZodString>;
  source_record_id: z.ZodNullable<z.ZodString>;
  activity_id: z.ZodNullable<z.ZodString>;
  member_activity_id: z.ZodNullable<z.ZodString>;
  measurement_kind: z.ZodEnum<["direct", "estimated", "unknown"]>;
}>;
export const qualityEvidenceSchema: z.ZodObject;
export const calculationEvidenceSchema: z.ZodObject;

export interface AnalyticalCursorPayload {
  version: 1;
  userId: string;
  activityId: string;
  shape: string;
  nextRecordedAt: string;
}
export function encodeAnalyticalCursor(payload: AnalyticalCursorPayload): string;
export function decodeAnalyticalCursor(
  cursor: string,
  expected: Pick<AnalyticalCursorPayload, "userId" | "activityId" | "shape">,
): AnalyticalCursorPayload;
```

- [x] **Step 1: Write failing evidence-schema tests.** Assert that every approved epistemic kind parses, `measurement_kind` rejects `"calculated"`, quality coverage accepts `null`, and an unavailable calculation requires a non-empty reason.

```ts
expect(sourceReferenceSchema.parse({
  provider_id: "wahoo",
  device_id: "Wahoo trainer",
  source_type: "fit",
  source_record_id: "sample-1",
  activity_id: activityId,
  member_activity_id: memberId,
  measurement_kind: "direct",
})).toMatchObject({ provider_id: "wahoo", measurement_kind: "direct" });
expect(() => unavailableMetricSchema.parse({ value: null, reason: "" })).toThrow();
```

- [x] **Step 2: Run the evidence tests and witness RED.**

Run: `pnpm vitest run --project unit packages/server/src/mcp/analytical-evidence.test.ts`

Expected: FAIL because `analytical-evidence.ts` does not exist.

- [x] **Step 3: Implement the shared evidence schemas.** Define the exact enums from the design, numeric coverage fields as nullable/non-negative, `reasons` and `assumptions` as arrays, and this reusable unavailable metric union:

```ts
export const unavailableMetricSchema = z.object({
  value: z.null(),
  reason: z.string().min(1),
});
```

- [x] **Step 4: Run the evidence tests and witness GREEN.**

Run: `pnpm vitest run --project unit packages/server/src/mcp/analytical-evidence.test.ts`

Expected: PASS with no warnings.

- [x] **Step 5: Write failing cursor tests.** Cover round-trip behavior, malformed Base64URL, unsupported version, changed user/activity/shape, invalid timestamp, and extra keys. The production change that makes these tests pass is strict Zod parsing plus expected-field comparison.

```ts
const cursor = encodeAnalyticalCursor({
  version: 1,
  userId,
  activityId,
  shape: "power,heart_rate|5s|none",
  nextRecordedAt: "2026-09-01T12:00:05.000Z",
});
expect(decodeAnalyticalCursor(cursor, { userId, activityId, shape })).toMatchObject({
  nextRecordedAt: "2026-09-01T12:00:05.000Z",
});
expect(() => decodeAnalyticalCursor(cursor, { userId, activityId, shape: "power|raw|none" }))
  .toThrow("Cursor does not match this request");
```

- [x] **Step 6: Run cursor tests and witness RED.**

Run: `pnpm vitest run --project unit packages/server/src/mcp/analytical-cursor.test.ts`

Expected: FAIL because the cursor module is absent.

- [x] **Step 7: Implement the cursor codec.** Serialize strict JSON as Base64URL, reject decoded payloads over 2 KiB, parse with `z.object(...).strict()`, compare all expected binding fields, and return the parsed payload. Authentication and repository ownership checks remain mandatory; the cursor is opaque paging state, not authorization.

- [x] **Step 8: Run both focused suites and commit.**

Run: `pnpm vitest run --project unit packages/server/src/mcp/analytical-evidence.test.ts packages/server/src/mcp/analytical-cursor.test.ts`

Expected: PASS.

```bash
git add packages/server/src/mcp/analytical-evidence.ts packages/server/src/mcp/analytical-evidence.test.ts packages/server/src/mcp/analytical-cursor.ts packages/server/src/mcp/analytical-cursor.test.ts
git commit -m "feat(mcp): add analytical evidence contracts"
git push
```

### Task 2: Deduped sensor provenance projection

**Files:**

- Modify: `analytics/models/staging/sensor_scalar_sample.sql`
- Modify: `analytics/models/read_models/deduped_sensor.sql`
- Modify: `analytics/models/read_models/activity_sensor_sample.sql`
- Modify: `analytics/models/read_models/activity_location_sample.sql`
- Modify: `analytics/models/read_models/read_model_microbatch.sql.test.ts`
- Modify: `src/db/clickhouse-deduped-sensor.ts`
- Modify: `src/db/clickhouse-deduped-sensor.test.ts`
- Create: `src/db/clickhouse-migrations/0076_activity_sensor_provenance.ts`
- Create: `src/db/clickhouse-migrations/0076_activity_sensor_provenance.test.ts`
- Create: `src/db/clickhouse-migrations/0076_activity_sensor_provenance.integration.test.ts`
- Modify: `src/db/clickhouse-migrations/registry.ts`
- Modify: `src/db/clickhouse-migrations/registry.test.ts`
- Create: `packages/server/src/repositories/activity-sensor-provenance.integration.test.ts`
- Modify: `packages/server/src/routers/clickhouse-integration-test-helpers.ts`
- Modify: `packages/server/src/routers/clickhouse-integration-test-models.ts`
- Modify: `packages/server/src/routers/clickhouse-integration-test-read-models-a.ts`

**Interfaces:**

- Consumes: `ingest.metric_stream` fields `id`, `activity_id`, `provider_id`, `external_id`, `device_id`, `source_type`, `metadata`, and existing provider/device priorities.
- Produces these additional `analytics.activity_sensor_sample` columns for Task 3's repository query:

```text
provider_id, member_activity_id, device_id, source_external_id, source_type,
source_metric_stream_id, measurement_kind
```

- [x] **Step 1: Extend the dbt and bootstrap tests first.** Assert that staging projects source `activity_id`, `external_id`, `source_type`, and a strict `measurement_kind` extracted from metadata; `deduped_sensor` selects all provenance with the same `argMinIf` ordering used for `scalar`; `activity_sensor_sample` forwards it without joining raw ingest data; and `activity_location_sample` preserves the winning GPS source and member activity. Add `distance` and `temperature` to the staged scalar channel allowlist. Assert the production bootstrap creates the same columns, and the new schema-only migration adds them to already-existing tables without an `INSERT` or historical backfill.

```ts
expect(sensorSql).toContain("argMax(external_id, version) AS external_id");
expect(dedupedSql).toContain("AS source_external_id");
expect(activitySampleSql).toContain("samples.provider_id AS provider_id");
expect(activitySampleSql).not.toContain("source('ingest'");
expect(locationSampleSql).toContain("location_rows.member_activity_id");
```

- [x] **Step 2: Run the dbt policy test and witness RED.**

Run: `pnpm vitest run --project unit analytics/models/read_models/read_model_microbatch.sql.test.ts src/db/clickhouse-deduped-sensor.test.ts src/db/clickhouse-migrations/0076_activity_sensor_provenance.test.ts src/db/clickhouse-migrations/registry.test.ts`

Expected: FAIL on missing provenance projections.

- [x] **Step 3: Modify the four dbt models, bootstrap SQL, and migration.** Use the existing winner tuple `(provider_priority, provider_id, id)` for every selected scalar provenance column. Normalize measurement kind exactly as follows so absent or unrecognized metadata stays unknown:

```sql
multiIf(
  JSONExtractString(metadata, 'measurement_kind') = 'direct', 'direct',
  JSONExtractString(metadata, 'measurement_kind') = 'estimated', 'estimated',
  'unknown'
) AS measurement_kind
```

Carry source `activity_id` as `member_activity_id` and the metric-stream UUID as `source_metric_stream_id`; retain provider external ID separately. Apply the same source fields to the already provider-selected location model. Add `on_schema_change='append_new_columns'` to affected incremental configs. Keep `clickhouse-deduped-sensor.ts` byte-for-byte equivalent in column meaning to the dbt staging/dedup models. Register migration `0076_activity_sensor_provenance` with `ADD COLUMN IF NOT EXISTS` statements only; historical recomputation remains the explicit operator action documented in Task 7. Do not copy the full metadata payload into downstream tables.

- [x] **Step 4: Run the dbt policy test and witness GREEN.**

Run: `pnpm vitest run --project unit analytics/models/read_models/read_model_microbatch.sql.test.ts src/db/clickhouse-deduped-sensor.test.ts src/db/clickhouse-migrations/0076_activity_sensor_provenance.test.ts src/db/clickhouse-migrations/registry.test.ts`

Expected: PASS.

- [x] **Step 5: Write executable ClickHouse integration tests.** Seed two providers at the same timestamp and channel with different priorities plus a measured zero from the winning provider. Build the current staging/dedup/activity-sample models in the isolated test database. Assert one row, scalar `0`, and winner provenance from Wahoo. Then tombstone Wahoo and assert the Peloton member becomes the visible source after refresh. Seed overlapping GPS points and assert the location row identifies its provider, device, source record, and member activity. Execute the schema migration twice against minimal real ClickHouse tables and verify its idempotent column types.

```ts
expect(rows).toEqual([expect.objectContaining({
  scalar: 0,
  provider_id: "wahoo",
  device_id: "Wahoo trainer",
  measurement_kind: "direct",
})]);
```

- [x] **Step 6: Run the integration test and witness RED.**

Run: `pnpm test:integration -- packages/server/src/repositories/activity-sensor-provenance.integration.test.ts`

Expected: FAIL because the current activity sample model omits provenance.

- [x] **Step 7: Specify the query contract used by Task 3.** Query only `analytics.activity_sensor_sample FINAL`, restrict by authenticated user, canonical activity ID, requested channels, activity timestamps, cursor timestamp, and `is_deleted = 0`; order by `recorded_at, channel`; request `limit + 1` rows to derive pagination. Use the existing generic `ActivitySensorStore.query` boundary so every current production store and test double retains one canonical query interface.

```sql
SELECT recorded_at, channel, scalar, provider_id, device_id, source_type,
       toString(source_metric_stream_id) AS source_record_id,
       toString(member_activity_id) AS member_activity_id, measurement_kind,
       scalar, CAST(NULL AS Nullable(Tuple(Float64, Float64))) AS position
FROM analytics.activity_sensor_sample FINAL
WHERE user_id = {userId:UUID}
  AND activity_id = {activityId:UUID}
  AND channel IN ({channels:Array(String)})
  AND recorded_at > parseDateTime64BestEffort({after:String})
  AND is_deleted = 0
ORDER BY recorded_at, channel
LIMIT {limit:UInt32}
```

Task 3 unions a shape-compatible query over `analytics.activity_location_sample FINAL`
when `position` is requested. It returns `channel='position'`, null scalar, a
`(lat, lng)` tuple, and the same source fields. Both branches remain restricted
to the authenticated canonical activity and its selected deduped samples.

- [x] **Step 8: Run the integration and existing sensor-store unit suites.**

Run: `pnpm test:integration -- packages/server/src/repositories/activity-sensor-provenance.integration.test.ts`

Run: `pnpm vitest run --project unit packages/server/src/repositories/clickhouse-activity-sensor-store.test.ts packages/server/src/repositories/limited-activity-sensor-store.test.ts`

Expected: PASS; query assertions prove no raw-ingest read.

- [x] **Step 9: Validate analytics SQL and commit.**

Run: `pnpm lint:analytics-sql`

Expected: PASS.

```bash
git add analytics/models/staging/sensor_scalar_sample.sql analytics/models/read_models/deduped_sensor.sql analytics/models/read_models/activity_sensor_sample.sql analytics/models/read_models/activity_location_sample.sql analytics/models/read_models/read_model_microbatch.sql.test.ts src/db/clickhouse-deduped-sensor.ts src/db/clickhouse-deduped-sensor.test.ts src/db/clickhouse-migrations/0076_activity_sensor_provenance.ts src/db/clickhouse-migrations/0076_activity_sensor_provenance.test.ts src/db/clickhouse-migrations/0076_activity_sensor_provenance.integration.test.ts src/db/clickhouse-migrations/registry.ts src/db/clickhouse-migrations/registry.test.ts packages/server/src/repositories/activity-sensor-provenance.integration.test.ts packages/server/src/routers/clickhouse-integration-test-helpers.ts packages/server/src/routers/clickhouse-integration-test-models.ts packages/server/src/routers/clickhouse-integration-test-read-models-a.ts
git commit -m "feat(analytics): preserve activity sensor provenance"
git push
```

### Task 3: Synchronized time-series domain and repository

**Files:**

- Create: `packages/server/src/repositories/activity-timeseries.ts`
- Create: `packages/server/src/repositories/activity-timeseries.test.ts`
- Create: `packages/server/src/repositories/activity-timeseries-repository.ts`
- Create: `packages/server/src/repositories/activity-timeseries-repository.test.ts`
- Modify: `packages/server/src/repositories/activity-repository.ts`
- Modify: `packages/server/src/repositories/activity-repository.test.ts`
- Modify: `packages/server/src/repositories/activity-sensor-provenance.integration.test.ts`

**Interfaces:**

- Consumes: `ActivityRepository.findById`, its private ownership-aware sensor window resolution exposed as a new production method `findSensorWindow(activityId)`, and `ActivitySensorStore.query`.
- Produces:

```ts
export type ActivityTimeseriesStream =
  | "power" | "heart_rate" | "cadence" | "speed" | "distance"
  | "altitude" | "grade" | "position" | "temperature"
  | "elapsed_time" | "moving_time";
export type TimeseriesResolution = "raw" | "1s" | "5s" | "10s" | "30s" | "60s";
export type TimeseriesFill = "none" | "linear";
export interface ActivityTimeseriesRequest {
  activityId: string;
  streams: ActivityTimeseriesStream[];
  resolution: TimeseriesResolution;
  fill: TimeseriesFill;
  cursor: string | null;
  limit: number;
}
export class ActivityTimeseriesRepository {
  list(request: ActivityTimeseriesRequest): Promise<ActivityTimeseriesPage>;
}
```

- [x] **Step 1: Write failing pure synchronization tests.** Use native power at `t=0: 0 W`, `t=2: 200 W`, HR at `t=1: 140`, and a missing `t=3` fixed bucket. Assert union timestamps at raw resolution, `measured_zero`, independent missing states, time-weighted fixed-bucket values, bounded linear fill, cumulative distance final-value behavior, and GPS pairs. Name each test after one state transition.

```ts
expect(page.streams.power).toMatchObject({
  values: [0, null, 200],
  states: ["measured_zero", "missing", "measured"],
});
```

- [x] **Step 2: Run the pure suite and witness RED.**

Run: `pnpm vitest run --project unit packages/server/src/repositories/activity-timeseries.test.ts`

Expected: FAIL because synchronization functions are missing.

- [x] **Step 3: Implement pure synchronization.** Raw timestamps are the ordered union of native samples. Fixed buckets use elapsed-time weighted means for scalar instantaneous streams, last observed value for cumulative distance, and the latest observed pair for position. Only interpolate internal scalar gaps bounded by observations; never extrapolate. Generate elapsed time from activity start. Generate moving time only from an explicitly supplied moving-time sample or a speed-derived calculation and return an availability reason otherwise.

- [x] **Step 4: Run pure tests and witness GREEN.**

Run: `pnpm vitest run --project unit packages/server/src/repositories/activity-timeseries.test.ts`

Expected: PASS.

- [x] **Step 5: Write failing repository tests.** Assert UUID ownership lookup precedes sensor query; aliases resolve to the canonical activity window; stream names map to metric channels (`position` maps to location, `distance` to distance, `temperature` to temperature); `limit + 1` determines `next_cursor`; source rows deduplicate into a source table and arrays contain source indexes; and mismatched cursors fail before querying ClickHouse.

```ts
expect(sensorStore.query).toHaveBeenCalledWith(
  expect.anything(),
  expect.stringContaining("FROM analytics.activity_sensor_sample FINAL"),
  expect.objectContaining({
    activityId: canonicalId,
    channels: ["heart_rate", "power"],
    limit: 1001,
  }),
);
```

- [x] **Step 6: Run repository tests and witness RED.**

Run: `pnpm vitest run --project unit packages/server/src/repositories/activity-timeseries-repository.test.ts`

Expected: FAIL because the repository is missing.

- [x] **Step 7: Implement the repository.** Add public `findSensorWindow` to `ActivityRepository` using the existing ownership-aware private query and update existing callers to use it. Reject inaccessible IDs with `Activity not found or not accessible.` Return activity source providers/member IDs/local time context, requested/effective resolution, columnar arrays, summaries, compact sources, and cursor. Fixed-resolution pages fetch enough native rows to finish the last returned bucket and set the next cursor to the next bucket boundary. Preserve moving-time continuity across pages by fetching prior speed support without exposing those timestamps as page points.

- [x] **Step 8: Run repository, existing activity, and real ClickHouse query suites.**

Run: `pnpm vitest run --project unit packages/server/src/repositories/activity-timeseries-repository.test.ts packages/server/src/repositories/activity-repository.test.ts`

Expected: PASS.

- [x] **Step 9: Commit the domain and repository.**

```bash
git add packages/server/src/repositories/activity-timeseries.ts packages/server/src/repositories/activity-timeseries.test.ts packages/server/src/repositories/activity-timeseries-repository.ts packages/server/src/repositories/activity-timeseries-repository.test.ts packages/server/src/repositories/activity-repository.ts packages/server/src/repositories/activity-repository.test.ts packages/server/src/repositories/activity-sensor-provenance.integration.test.ts
git commit -m "feat(server): add synchronized activity time series"
git push
```

### Task 4: `get_activity_timeseries` MCP tool

**Files:**

- Create: `packages/server/src/mcp/activity-timeseries-tool.ts`
- Create: `packages/server/src/mcp/activity-timeseries-tool.test.ts`
- Modify: `packages/server/src/mcp/tool-output.ts`
- Modify: `packages/server/src/mcp/tools.ts`
- Modify: `packages/server/src/mcp/route.test.ts`

**Interfaces:**

- Consumes: `ActivityTimeseriesRepository.list(request)` from Task 3.
- Produces the MCP tool `get_activity_timeseries` with input defaults `resolution="raw"`, `fill="none"`, `limit=500` and hard maximum `2_000`.

- [x] **Step 1: Write the tool test first.** Instantiate an MCP server with a stub repository and assert scope enforcement, ClickHouse precondition, defaults, selected stream pass-through, malformed cursor error text, output schema validation, and preservation of zero/null/state arrays.

```ts
expect(repository.list).toHaveBeenCalledWith({
  activityId,
  streams: ["power", "heart_rate"],
  resolution: "5s",
  fill: "none",
  cursor: null,
  limit: 500,
});
expect(result.result.streams.power.values).toEqual([0, null, 225]);
```

- [x] **Step 2: Run the tool test and witness RED.**

Run: `pnpm vitest run --project unit packages/server/src/mcp/activity-timeseries-tool.test.ts`

Expected: FAIL because the tool is not registered.

- [x] **Step 3: Implement and register the tool.** Define input enums exactly from the design, call `requireMcpScope(context.scopes, "activity:read")`, fail specifically when `context.sensorStore` is absent, and pass the repository result through `jsonToolResult`. Add a strict output schema for every column and evidence object. Do not modify `get_activity_streams`.

- [x] **Step 4: Add public-route contract coverage.** Extend `route.test.ts` to call `tools/list`, assert both legacy and new stream tools, call the new tool through MCP transport, and parse the structured result with `activityTimeseriesOutputSchema`. The existing app resource has no tool catalog and remains unchanged; tool discovery is owned by MCP `tools/list`.

- [x] **Step 5: Run MCP suites and witness GREEN.**

Run: `pnpm vitest run --project unit packages/server/src/mcp/activity-timeseries-tool.test.ts packages/server/src/mcp/route.test.ts packages/server/src/mcp/app-resource.test.ts`

Expected: PASS.

- [x] **Step 6: Commit the MCP surface.**

```bash
git add packages/server/src/mcp/activity-timeseries-tool.ts packages/server/src/mcp/activity-timeseries-tool.test.ts packages/server/src/mcp/tool-output.ts packages/server/src/mcp/tools.ts packages/server/src/mcp/route.test.ts packages/server/src/repositories/activity-timeseries-repository.test.ts
git commit -m "feat(mcp): expose activity time series"
git push
```

### Task 5: Correct elapsed-time power-duration read model

**Files:**

- Modify: `analytics/models/read_models/activity_power_curve.sql`
- Modify: `analytics/models/read_models/activity_power_curve.sql.test.ts`
- Modify: `packages/server/src/routers/activity-power-curve-read-model.integration.test.ts`
- Create: `packages/training/src/power-duration-reference.ts`
- Create: `packages/training/src/power-duration-reference.test.ts`
- Modify: `packages/training/package.json`

**Interfaces:**

- Consumes: deduped `analytics.activity_sensor_sample` power rows, including zero and provenance columns.
- Produces `analytics.activity_power_curve` rows with:

```text
activity_id, user_id, started_at, activity_date, duration_seconds,
best_power, start_offset_seconds, observed_samples, median_sample_interval_seconds,
largest_gap_seconds, coverage_pct, power_measurement_kind,
source_providers Array(String), source_devices Array(String),
is_deleted, refresh_version, refreshed_at
```

- [x] **Step 1: Write the independent numerical reference tests.** Implement tests before the reference function. Fixtures must include constant 250 W at 1 Hz, a measured zero inside a window, irregular timestamps with a fractional boundary, a dropout that invalidates a high candidate, and five-second Peloton samples where one-second power is unavailable.

```ts
expect(referenceBestPower(constant250, 20)).toMatchObject({ watts: 250, startOffsetSeconds: 0 });
expect(referenceBestPower(withDropout, 30)).toBeNull();
expect(referenceBestPower(fiveSecondSamples, 1)).toBeNull();
```

- [x] **Step 2: Run the reference tests and witness RED.**

Run: `pnpm vitest run --project unit packages/training/src/power-duration-reference.test.ts`

Expected: FAIL because the reference function is absent.

- [x] **Step 3: Implement the small reference integrator.** Sort samples, reject negative/non-finite power, preserve zero, calculate the median positive interval, treat each sample as a left-continuous step until the next sample, interpolate cumulative energy at window boundaries, reject windows crossing excessive gaps, and reject requested durations shorter than the median source interval. Export it through an explicit package subpath because production custom-duration validation in Task 6 also consumes it; this is not a test-only export.

- [x] **Step 4: Run reference tests and witness GREEN.**

Run: `pnpm vitest run --project unit packages/training/src/power-duration-reference.test.ts`

Expected: PASS.

- [x] **Step 5: Strengthen the dbt SQL tests before changing SQL.** Assert the duration array contains the approved default list plus legacy 3-minute, 7-minute, and 120-minute points, `scalar >= 0` rather than `scalar > 0`, window energy supports fractional duration endpoints, output includes start offset/coverage/provenance, and no equality join to `addSeconds(start, duration)` remains.

- [x] **Step 6: Run dbt SQL tests and witness RED.**

Run: `pnpm vitest run --project unit analytics/models/read_models/activity_power_curve.sql.test.ts`

Expected: FAIL on duration list, zero filtering, and endpoint semantics.

- [x] **Step 7: Rewrite the dbt calculation.** Use sorted timestamp/power arrays; derive interval durations, cumulative energy, cumulative discontinuities, median interval, and candidate start times; calculate energy at `start + duration` from the containing segment rather than exact timestamp equality; rank by average power and earliest start offset. Return null/no active row for unsupported resolution. Propagate the set of selected source providers/devices and collapse measurement kind to `estimated` if any contributing source is estimated, `direct` only if all are direct, otherwise `unknown`.

- [x] **Step 8: Extend the executable ClickHouse integration fixture.** Seed the same five reference cases and compare `best_power` and `start_offset_seconds` to `referenceBestPower`. Add duplicate Wahoo/Strava samples with overlapping streams and assert only the canonical sample set contributes one curve. Assert the zero sample lowers the result and the dropout candidate is excluded.

- [x] **Step 9: Run unit and integration suites.**

Run: `pnpm vitest run --project unit packages/training/src/power-duration-reference.test.ts analytics/models/read_models/activity_power_curve.sql.test.ts`

Run: `pnpm test:integration -- packages/server/src/routers/activity-power-curve-read-model.integration.test.ts`

Expected: PASS and numeric results match the independent fixture within `0.1 W`.

- [x] **Step 10: Validate SQL and commit.**

Run: `pnpm lint:analytics-sql`

Expected: PASS.

```bash
git add analytics/models/read_models/activity_power_curve.sql analytics/models/read_models/activity_power_curve.sql.test.ts packages/server/src/routers/activity-power-curve-read-model.integration.test.ts packages/training/src/power-duration-reference.ts packages/training/src/power-duration-reference.test.ts packages/training/package.json
git commit -m "fix(analytics): calculate elapsed-time power curves"
git push
```

### Task 6: Nearby weight evidence and power-curve repository

**Files:**

- Create: `packages/server/src/repositories/nearby-weight.ts`
- Create: `packages/server/src/repositories/nearby-weight.test.ts`
- Create: `packages/server/src/repositories/cycling-power-curve-repository.ts`
- Create: `packages/server/src/repositories/cycling-power-curve-repository.test.ts`
- Create: `packages/server/src/repositories/cycling-power-curve-repository.integration.test.ts`

**Interfaces:**

- Consumes: `analytics.activity_power_curve`, `analytics.activity_sensor_sample`, `analytics.v_body_measurement`, deduped activity source evidence, and `referenceBestPower` only for bounded custom-duration result verification in tests.
- Produces:

```ts
export function selectNearbyWeight(
  effortDate: string,
  measurements: DirectWeightObservation[],
): WeightEvidence | { value_kg: null; reason: string };

export class CyclingPowerCurveRepository {
  listRange(input: {
    startDate: string;
    endDate: string;
    durationsSeconds: number[];
    modalities: string[];
    providers: string[];
    includeActivityCurve: boolean;
    cursor: string | null;
    limit: number;
  }): Promise<CyclingPowerCurvePage>;
}
```

- [x] **Step 1: Write failing nearby-weight tests.** Cover same-day, 14-day two-sided interpolation, 30-day nearest, earlier tie, measurements outside bounds, zero/negative weights, and consumer BIA composition not being accepted as body weight.

```ts
expect(selectNearbyWeight("2026-06-15", [
  measured("2026-06-10", 70), measured("2026-06-20", 72),
])).toMatchObject({ value_kg: 71, method: "interpolated", kind: "interpolated" });
```

- [x] **Step 2: Run the weight tests and witness RED.**

Run: `pnpm vitest run --project unit packages/server/src/repositories/nearby-weight.test.ts`

Expected: FAIL because the selector is absent.

- [x] **Step 3: Implement weight matching and run GREEN.** Preserve every contributing date/provider and return distance days and quality. Never use body-fat or lean-mass channels as weight.

Run: `pnpm vitest run --project unit packages/server/src/repositories/nearby-weight.test.ts`

Expected: PASS.

- [x] **Step 4: Write failing repository tests.** Assert default/model durations query the materialized table; custom durations use a parameterized bounded `activity_sensor_sample` query; providers and modalities filter canonical activities without multiplying duplicate members; result ordering is duration ascending then watts descending; every record includes offset, source, measurement kind, quality, weight evidence, and W/kg or an explicit reason; and the activity-curve cursor is stable.

```ts
expect(result.bests[0]).toMatchObject({
  duration_seconds: 1200,
  watts: 300,
  watts_per_kg: 4.225,
  activity_id: canonicalId,
  start_offset_seconds: 420,
  power_kind: "direct",
});
```

- [x] **Step 5: Run repository tests and witness RED.**

Run: `pnpm vitest run --project unit packages/server/src/repositories/cycling-power-curve-repository.test.ts`

Expected: FAIL because the repository does not exist.

- [x] **Step 6: Implement model and custom queries.** Use `duration_seconds IN ({durations:Array(UInt32)})` for standard rows. For custom rows, use the same cumulative-energy and gap algorithm as the dbt model inside one authenticated, date-bounded ClickHouse query and return only winning rows. Query weight observations once for `startDate - 30 days` through `endDate + 30 days`, then apply `selectNearbyWeight` per winning effort. Reject more than 32 durations before a query.

- [x] **Step 7: Add executable integration coverage.** Seed a 1 Hz outdoor Wahoo ride, irregular Wahoo samples, five-second Peloton ride, duplicate Strava activity, and weights around the winning date. Assert 5/20/30/60-minute results, an arbitrary non-model duration, W/kg, missing-weight reason, provider filtering, and no duplicate volume/result.

- [x] **Step 8: Run repository suites and witness GREEN.**

Run: `pnpm vitest run --project unit packages/server/src/repositories/nearby-weight.test.ts packages/server/src/repositories/cycling-power-curve-repository.test.ts`

Run: `pnpm test:integration -- packages/server/src/repositories/cycling-power-curve-repository.integration.test.ts`

Expected: PASS.

- [x] **Step 9: Commit the repository.**

```bash
git add packages/server/src/repositories/nearby-weight.ts packages/server/src/repositories/nearby-weight.test.ts packages/server/src/repositories/cycling-power-curve-repository.ts packages/server/src/repositories/cycling-power-curve-repository.test.ts packages/server/src/repositories/cycling-power-curve-repository.integration.test.ts
git commit -m "feat(server): add provenance-rich cycling power curves"
git push
```

### Task 7: `get_cycling_power_curve` MCP tool and compatibility verification

**Files:**

- Create: `packages/server/src/mcp/cycling-power-curve-tool.ts`
- Create: `packages/server/src/mcp/cycling-power-curve-tool.test.ts`
- Modify: `packages/server/src/mcp/tool-output.ts`
- Modify: `packages/server/src/mcp/tools.ts`
- Modify: `packages/server/src/mcp/route.test.ts`
- Modify: `packages/server/src/mcp/app-resource.ts`
- Modify: `packages/server/src/mcp/app-resource.test.ts`
- Modify: `packages/server/README.md`
- Modify: `analytics/README.md`

**Interfaces:**

- Consumes: `CyclingPowerCurveRepository.listRange` from Task 6.
- Produces: `get_cycling_power_curve` with exact-range/provider/modality/duration filters, optional activity-curve pagination, and `activity:read` scope.

- [ ] **Step 1: Write the tool test first.** Cover defaults, arbitrary durations, duplicate duration rejection after normalization, start/end validation, maximum duration/count, pagination, missing ClickHouse, scope denial, and strict output parsing.

```ts
expect(repository.listRange).toHaveBeenCalledWith(expect.objectContaining({
  startDate: "2026-03-01",
  endDate: "2026-08-28",
  durationsSeconds: [300, 1200, 1800, 3600],
}));
```

- [ ] **Step 2: Run the tool test and witness RED.**

Run: `pnpm vitest run --project unit packages/server/src/mcp/cycling-power-curve-tool.test.ts`

Expected: FAIL because the tool is absent.

- [ ] **Step 3: Implement and register the tool.** Normalize requested duration order, reject duplicates with `durations must be unique`, use `assertDateRange`, require ClickHouse, register the exact output schema, and leave `get_cycling_performance` unchanged.

- [ ] **Step 4: Extend transport and resource tests.** Assert both cycling tools appear in `tools/list`; call the new tool through authenticated MCP transport; verify `activity:read` succeeds while `health:read` alone fails; validate compact result size and contribution IDs.

- [ ] **Step 5: Run MCP tests and witness GREEN.**

Run: `pnpm vitest run --project unit packages/server/src/mcp/cycling-power-curve-tool.test.ts packages/server/src/mcp/route.test.ts packages/server/src/mcp/app-resource.test.ts`

Expected: PASS.

- [ ] **Step 6: Document formulas and operator refresh.** In the server README list inputs, defaults, null/reason semantics, and scope for both new tools. In the analytics README document the elapsed-time integration, measured-zero behavior, continuity tolerance, and the explicit bounded full-refresh procedure required for historical `activity_power_curve` rows. Do not put that historical rebuild in deploy/runtime code.

- [ ] **Step 7: Run the subsystem verification.**

Run: `pnpm lint`

Run: `pnpm typecheck`

Run: `pnpm test:changed:all`

Run: `pnpm knip`

Expected: all commands PASS without warnings attributable to this change. If sandbox port restrictions reproduce `unexpected address`, rerun the unchanged test command outside the sandbox and record both results.

- [ ] **Step 8: Review backward compatibility and commit.** Confirm `get_activity_streams` and `get_cycling_performance` snapshots are unchanged; confirm no client computes metrics; inspect `git diff --check` and all source/provenance fields.

```bash
git add packages/server/src/mcp/cycling-power-curve-tool.ts packages/server/src/mcp/cycling-power-curve-tool.test.ts packages/server/src/mcp/tool-output.ts packages/server/src/mcp/tools.ts packages/server/src/mcp/route.test.ts packages/server/src/mcp/app-resource.ts packages/server/src/mcp/app-resource.test.ts packages/server/README.md analytics/README.md
git commit -m "feat(mcp): expose cycling power curves"
git push
```

## Review Checkpoint

Stop after Task 7. Demonstrate the four acceptance queries for best 5/20/30/60-minute power over both 90 and 180 days against the authorized current dataset, including provenance, W/kg evidence, and missing-data reasons. Record any unavailable source stream or historical refresh requirement before writing or executing the threshold/workout/load plan.
