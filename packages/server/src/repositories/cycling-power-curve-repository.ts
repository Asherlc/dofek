import { createHash } from "node:crypto";
import { z } from "zod";
import type { ActivitySensorStore } from "./activity-repository.ts";
import {
  type DirectWeightObservation,
  selectNearbyWeight,
  type UnavailableWeightEvidence,
  type WeightEvidence,
} from "./nearby-weight.ts";

const MODEL_DURATIONS = new Set([
  1, 5, 15, 30, 60, 120, 180, 300, 420, 600, 720, 1200, 1800, 2400, 3600, 5400, 7200,
]);

const curveRowSchema = z.object({
  activity_id: z.string().uuid(),
  activity_date: z.string(),
  started_at: z.string(),
  canonical_type: z.string(),
  duration_seconds: z.coerce.number().int().positive(),
  best_power: z.coerce.number().nonnegative(),
  start_offset_seconds: z.coerce.number().nonnegative().nullable(),
  observed_samples: z.coerce.number().int().nonnegative().nullable(),
  median_sample_interval_seconds: z.coerce.number().positive().nullable(),
  largest_gap_seconds: z.coerce.number().nonnegative().nullable(),
  coverage_pct: z.coerce.number().min(0).max(100).nullable(),
  power_measurement_kind: z.enum(["direct", "estimated", "unknown"]).nullable(),
  source_providers: z.array(z.string()),
  source_devices: z.array(z.string()),
  member_activity_ids: z.array(z.string().uuid()),
});

type CurveRow = z.infer<typeof curveRowSchema>;

const customCurveRowSchema = z.object({
  result_activity_id: z.string().uuid(),
  result_activity_date: z.string(),
  result_started_at: z.string(),
  result_canonical_type: z.string(),
  result_duration_seconds: z.coerce.number().int().positive(),
  result_best_power: z.coerce.number().nonnegative(),
  result_start_offset_seconds: z.coerce.number().nonnegative().nullable(),
  result_observed_samples: z.coerce.number().int().nonnegative().nullable(),
  result_median_sample_interval_seconds: z.coerce.number().positive().nullable(),
  result_largest_gap_seconds: z.coerce.number().nonnegative().nullable(),
  result_coverage_pct: z.coerce.number().min(0).max(100).nullable(),
  result_power_measurement_kind: z.enum(["direct", "estimated", "unknown"]).nullable(),
  result_source_providers: z.array(z.string()),
  result_source_devices: z.array(z.string()),
  result_member_activity_ids: z.array(z.string().uuid()),
});

function normalizeCustomCurveRow(row: z.infer<typeof customCurveRowSchema>): CurveRow {
  return {
    activity_id: row.result_activity_id,
    activity_date: row.result_activity_date,
    started_at: row.result_started_at,
    canonical_type: row.result_canonical_type,
    duration_seconds: row.result_duration_seconds,
    best_power: row.result_best_power,
    start_offset_seconds: row.result_start_offset_seconds,
    observed_samples: row.result_observed_samples,
    median_sample_interval_seconds: row.result_median_sample_interval_seconds,
    largest_gap_seconds: row.result_largest_gap_seconds,
    coverage_pct: row.result_coverage_pct,
    power_measurement_kind: row.result_power_measurement_kind,
    source_providers: row.result_source_providers,
    source_devices: row.result_source_devices,
    member_activity_ids: row.result_member_activity_ids,
  };
}

const weightRowSchema = z.object({
  date: z.string(),
  recorded_at: z.string(),
  weight_kg: z.coerce.number(),
  provider_id: z.string(),
  external_id: z.string().nullable(),
});

const cursorSchema = z.object({
  version: z.literal(1),
  userId: z.string().uuid(),
  shape: z.string(),
  duration: z.number().int().positive(),
  watts: z.number().nonnegative(),
  startedAt: z.string(),
  activityId: z.string().uuid(),
});

interface CurveCursor extends z.infer<typeof cursorSchema> {}

export interface CyclingPowerCurveInput {
  startDate: string;
  endDate: string;
  durationsSeconds: number[];
  modalities: string[];
  providers: string[];
  includeActivityCurve: boolean;
  cursor: string | null;
  limit: number;
}

export interface CyclingPowerCurveEffort {
  duration_seconds: number;
  watts: number;
  watts_per_kg: number | null;
  watts_per_kg_reason: string | null;
  weight: WeightEvidence | UnavailableWeightEvidence;
  activity_id: string;
  date: string;
  started_at: string;
  start_offset_seconds: number | null;
  canonical_type: string;
  power_kind: "direct" | "estimated" | "unknown";
  source_providers: string[];
  source_devices: string[];
  member_activity_ids: string[];
  quality: {
    status: "high" | "moderate" | "limited";
    reasons: string[];
    observed_samples: number | null;
    coverage_pct: number | null;
    continuity_tolerance_seconds: number | null;
    median_sample_interval_seconds: number | null;
    largest_gap_seconds: number | null;
  };
}

export interface CyclingPowerCurvePage {
  start_date: string;
  end_date: string;
  durations_seconds: number[];
  bests: CyclingPowerCurveEffort[];
  activity_curve: CyclingPowerCurveEffort[];
  next_cursor: string | null;
}

function filterSql(alias: string): string {
  return `
    ${alias}.user_id = {userId:UUID}
    AND ${alias}.is_deleted = 0
    AND toDate(toTimeZone(${alias}.started_at, {timezone:String}))
      BETWEEN toDate({startDate:String}) AND toDate({endDate:String})
    AND ${alias}.canonical_type = 'cycling'
    AND (empty({modalities:Array(String)}) OR has({modalities:Array(String)}, ${alias}.modality))
    AND (
      empty({providers:Array(String)})
      OR hasAny(${alias}.source_providers, {providers:Array(String)})
    )`;
}

function curveColumns(source: string, activitySource = source): string {
  return `
    toString(${source}.activity_id) AS activity_id,
    toString(toDate(toTimeZone(${source}.started_at, {timezone:String}))) AS activity_date,
    formatDateTime(${source}.started_at, '%Y-%m-%dT%H:%i:%S.%fZ', 'UTC') AS started_at,
    ${activitySource}.canonical_type AS canonical_type,
    ${source}.duration_seconds AS duration_seconds,
    ${source}.best_power AS best_power,
    ${source}.start_offset_seconds AS start_offset_seconds,
    ${source}.observed_samples AS observed_samples,
    ${source}.median_sample_interval_seconds AS median_sample_interval_seconds,
    ${source}.largest_gap_seconds AS largest_gap_seconds,
    ${source}.coverage_pct AS coverage_pct,
    ${source}.power_measurement_kind AS power_measurement_kind,
    ${source}.source_providers AS source_providers,
    ${source}.source_devices AS source_devices,
    ${activitySource}.member_activity_ids AS member_activity_ids`;
}

function cursorClause(cursor: CurveCursor | null, source: string): string {
  if (!cursor) return "";
  return `AND (
    ${source}.duration_seconds > {cursorDuration:UInt32}
    OR (${source}.duration_seconds = {cursorDuration:UInt32} AND ${source}.best_power < {cursorWatts:Float64})
    OR (
      ${source}.duration_seconds = {cursorDuration:UInt32}
      AND ${source}.best_power = {cursorWatts:Float64}
      AND ${source}.started_at < parseDateTime64BestEffort({cursorStartedAt:String}, 6)
    )
    OR (
      ${source}.duration_seconds = {cursorDuration:UInt32}
      AND ${source}.best_power = {cursorWatts:Float64}
      AND ${source}.started_at = parseDateTime64BestEffort({cursorStartedAt:String}, 6)
      AND ${source}.activity_id > {cursorActivityId:UUID}
    )
  )`;
}

function customCursorClause(cursor: CurveCursor | null): string {
  if (!cursor) return "";
  return `AND (
    custom_curve.result_duration_seconds > {cursorDuration:UInt32}
    OR (
      custom_curve.result_duration_seconds = {cursorDuration:UInt32}
      AND custom_curve.result_best_power < {cursorWatts:Float64}
    )
    OR (
      custom_curve.result_duration_seconds = {cursorDuration:UInt32}
      AND custom_curve.result_best_power = {cursorWatts:Float64}
      AND custom_curve.result_started_at < parseDateTime64BestEffort({cursorStartedAt:String}, 6)
    )
    OR (
      custom_curve.result_duration_seconds = {cursorDuration:UInt32}
      AND custom_curve.result_best_power = {cursorWatts:Float64}
      AND custom_curve.result_started_at = parseDateTime64BestEffort({cursorStartedAt:String}, 6)
      AND custom_curve.result_activity_id > {cursorActivityId:UUID}
    )
  )`;
}

function standardSql(mode: "bests" | "page", cursor: CurveCursor | null): string {
  const cursorFilter = cursorClause(cursor, "power_curve");
  const suffix =
    mode === "bests"
      ? `QUALIFY row_number() OVER (
          PARTITION BY power_curve.duration_seconds
          ORDER BY power_curve.best_power DESC, power_curve.started_at DESC, power_curve.activity_id ASC
        ) = 1
        ORDER BY duration_seconds ASC`
      : `ORDER BY duration_seconds ASC, best_power DESC, started_at DESC, activity_id ASC
        LIMIT {pageLimit:UInt32}`;
  return `/* power-curve:standard:${mode} */
    SELECT ${curveColumns("power_curve", "activity")}
    FROM analytics.activity_power_curve AS power_curve FINAL
    INNER JOIN analytics.deduped_activities AS activity FINAL
      ON activity.activity_id = power_curve.activity_id
      AND activity.user_id = power_curve.user_id
    WHERE ${filterSql("activity")}
      AND power_curve.is_deleted = 0
      AND power_curve.duration_seconds IN ({durations:Array(UInt32)})
      ${cursorFilter}
    ${suffix}
    SETTINGS prefer_column_name_to_alias = 1`;
}

function customSql(mode: "bests" | "page", cursor: CurveCursor | null): string {
  const cursorFilter = customCursorClause(cursor);
  const suffix =
    mode === "bests"
      ? `QUALIFY row_number() OVER (
          PARTITION BY custom_curve.result_duration_seconds
          ORDER BY custom_curve.result_best_power DESC,
            custom_curve.result_started_at DESC,
            custom_curve.result_activity_id ASC
        ) = 1
        ORDER BY result_duration_seconds ASC`
      : `ORDER BY result_duration_seconds ASC, result_best_power DESC,
          result_started_at DESC, result_activity_id ASC
        LIMIT {pageLimit:UInt32}`;
  return `/* power-curve:custom:${mode} */
    SELECT
      custom_curve.result_activity_id,
      custom_curve.result_activity_date,
      custom_curve.result_started_at,
      custom_curve.result_canonical_type,
      custom_curve.result_duration_seconds,
      custom_curve.result_best_power,
      custom_curve.result_start_offset_seconds,
      custom_curve.result_observed_samples,
      custom_curve.result_median_sample_interval_seconds,
      custom_curve.result_largest_gap_seconds,
      custom_curve.result_coverage_pct,
      custom_curve.result_power_measurement_kind,
      custom_curve.result_source_providers,
      custom_curve.result_source_devices,
      custom_curve.result_member_activity_ids
    FROM (
    WITH selected_activities AS MATERIALIZED (
      SELECT
        activity_id, user_id, started_at, canonical_type, source_providers,
        member_activity_ids
      FROM analytics.deduped_activities FINAL
      WHERE ${filterSql("analytics.deduped_activities")}
    ),
    power_sample_groups AS (
      SELECT
        activity.activity_id,
        activity.user_id,
        activity.started_at,
        activity.canonical_type,
        arraySort(sample -> sample.1, groupArray((
          sensor.recorded_at,
          toFloat64(assumeNotNull(sensor.scalar)),
          ifNull(sensor.provider_id, ''),
          ifNull(sensor.device_id, ''),
          sensor.measurement_kind
        ))) AS samples
      FROM selected_activities AS activity
      INNER JOIN analytics.activity_sensor_sample AS sensor FINAL
        ON sensor.activity_id = activity.activity_id
        AND sensor.user_id = activity.user_id
        AND sensor.channel = 'power'
        AND sensor.scalar >= 0
        AND sensor.is_deleted = 0
      GROUP BY activity.activity_id, activity.user_id, activity.started_at, activity.canonical_type
    ),
    power_sample_arrays AS (
      SELECT
        activity_id, user_id, started_at, canonical_type,
        arrayMap(sample -> sample.1, samples) AS recorded_times,
        arrayMap(sample -> dateDiff('millisecond', started_at, sample.1) / 1000.0, samples) AS recorded_offsets,
        arrayMap(sample -> sample.2, samples) AS powers,
        arrayMap(sample -> sample.3, samples) AS providers,
        arrayMap(sample -> sample.4, samples) AS devices,
        arrayMap(sample -> sample.5, samples) AS measurement_kinds
      FROM power_sample_groups
      WHERE length(samples) > 1
    ),
    power_sample_segments AS (
      SELECT *, arrayMap(
        sample_index -> recorded_offsets[sample_index + 1] - recorded_offsets[sample_index],
        arrayEnumerate(arrayPopBack(recorded_offsets))
      ) AS segment_seconds
      FROM power_sample_arrays
    ),
    power_sample_resolution AS (
      SELECT *,
        arraySort(segment_seconds) AS sorted_segment_seconds,
        (
          sorted_segment_seconds[intDiv(length(sorted_segment_seconds) + 1, 2)]
          + sorted_segment_seconds[intDiv(length(sorted_segment_seconds), 2) + 1]
        ) / 2.0 AS median_sample_interval_seconds
      FROM power_sample_segments
      WHERE arrayAll(interval_seconds -> interval_seconds > 0, segment_seconds)
    ),
    power_sample_state AS (
      SELECT *,
        arrayCumSum(arrayConcat([toFloat64(0)], arrayMap(
          (power, seconds) -> power * seconds,
          arrayPopBack(powers), segment_seconds
        ))) AS cumulative_energy,
        greatest(5.0, median_sample_interval_seconds * 2.0) AS continuity_tolerance_seconds,
        arrayCumSum(arrayConcat([toUInt64(0)], arrayMap(
          seconds -> toUInt64(seconds > continuity_tolerance_seconds), segment_seconds
        ))) AS cumulative_discontinuities
      FROM power_sample_resolution
    ),
    power_sample_endpoints AS MATERIALIZED (
      SELECT
        activity_id, user_id, started_at, canonical_type,
        sample_index,
        sample_recorded_at AS recorded_at,
        sample_recorded_offset AS recorded_offset,
        previous_power,
        previous_segment_seconds,
        endpoint_cumulative_energy AS cumulative_energy,
        endpoint_cumulative_discontinuities AS cumulative_discontinuities,
        median_sample_interval_seconds,
        sample_provider AS provider,
        sample_device AS device,
        sample_measurement_kind AS measurement_kind
      FROM power_sample_state
      ARRAY JOIN
        arrayEnumerate(recorded_times) AS sample_index,
        recorded_times AS sample_recorded_at,
        recorded_offsets AS sample_recorded_offset,
        arrayConcat([toFloat64(0)], arrayPopBack(powers)) AS previous_power,
        arrayConcat([toFloat64(0)], segment_seconds) AS previous_segment_seconds,
        cumulative_energy AS endpoint_cumulative_energy,
        cumulative_discontinuities AS endpoint_cumulative_discontinuities,
        providers AS sample_provider,
        devices AS sample_device,
        measurement_kinds AS sample_measurement_kind
    ),
    duration_values AS (
      SELECT arrayJoin({durations:Array(UInt32)}) AS duration_seconds
    ),
    duration_windows AS (
      SELECT
        start_sample.activity_id AS window_activity_id,
        start_sample.user_id AS window_user_id,
        start_sample.started_at AS window_started_at,
        start_sample.canonical_type AS window_canonical_type,
        duration_values.duration_seconds AS window_duration_seconds,
        start_sample.sample_index AS window_start_sample_index,
        end_sample.sample_index AS window_end_endpoint_index,
        start_sample.recorded_offset AS window_start_offset_seconds,
        start_sample.recorded_offset + duration_values.duration_seconds AS window_end_offset_seconds,
        (
          end_sample.cumulative_energy
          - end_sample.previous_power * greatest(
            0,
            end_sample.recorded_offset
              - (start_sample.recorded_offset + duration_values.duration_seconds)
          )
          - start_sample.cumulative_energy
        ) / duration_values.duration_seconds AS window_avg_power,
        end_sample.cumulative_discontinuities
          - start_sample.cumulative_discontinuities AS window_discontinuity_count,
        end_sample.sample_index - start_sample.sample_index
          + toUInt64(
            end_sample.recorded_offset
              = start_sample.recorded_offset + duration_values.duration_seconds
          ) AS window_observed_samples,
        start_sample.median_sample_interval_seconds AS window_median_sample_interval_seconds
      FROM power_sample_endpoints AS start_sample
      CROSS JOIN duration_values
      ASOF INNER JOIN power_sample_endpoints AS end_sample
        ON end_sample.activity_id = start_sample.activity_id
        AND end_sample.user_id = start_sample.user_id
        AND end_sample.recorded_at >= addMilliseconds(
          start_sample.recorded_at, duration_values.duration_seconds * 1000
        )
      WHERE duration_values.duration_seconds >= start_sample.median_sample_interval_seconds
    ),
    winning_windows AS (
      SELECT
        duration_windows.window_activity_id,
        duration_windows.window_user_id,
        duration_windows.window_started_at,
        duration_windows.window_canonical_type,
        duration_windows.window_duration_seconds,
        duration_windows.window_start_sample_index,
        duration_windows.window_end_endpoint_index,
        duration_windows.window_start_offset_seconds,
        duration_windows.window_avg_power,
        duration_windows.window_observed_samples,
        duration_windows.window_median_sample_interval_seconds
      FROM duration_windows
      WHERE duration_windows.window_discontinuity_count = 0
        AND duration_windows.window_avg_power >= 0
      QUALIFY row_number() OVER (
        PARTITION BY duration_windows.window_activity_id, duration_windows.window_user_id,
          duration_windows.window_duration_seconds
        ORDER BY duration_windows.window_avg_power DESC,
          duration_windows.window_start_offset_seconds ASC
      ) = 1
    ),
    winning_evidence AS (
      SELECT
        winning.window_activity_id AS evidence_activity_id,
        winning.window_user_id AS evidence_user_id,
        any(winning.window_started_at) AS evidence_started_at,
        any(winning.window_canonical_type) AS evidence_canonical_type,
        winning.window_duration_seconds AS evidence_duration_seconds,
        toInt32(round(any(winning.window_avg_power))) AS evidence_best_power,
        any(winning.window_start_offset_seconds) AS evidence_start_offset_seconds,
        any(winning.window_observed_samples) AS evidence_observed_samples,
        any(winning.window_median_sample_interval_seconds) AS evidence_median_sample_interval_seconds,
        maxIf(
          sample.previous_segment_seconds,
          sample.sample_index > winning.window_start_sample_index
        ) AS evidence_largest_gap_seconds,
        toFloat64(100) AS coverage_pct,
        groupArrayIf(
          sample.measurement_kind,
          sample.sample_index < winning.window_start_sample_index + winning.window_observed_samples
        ) AS kinds,
        arraySort(groupUniqArrayIf(
          sample.provider,
          sample.provider != ''
            AND sample.sample_index < winning.window_start_sample_index + winning.window_observed_samples
        )) AS source_providers,
        arraySort(groupUniqArrayIf(
          sample.device,
          sample.device != ''
            AND sample.sample_index < winning.window_start_sample_index + winning.window_observed_samples
        )) AS source_devices
      FROM winning_windows AS winning
      INNER JOIN power_sample_endpoints AS sample
        ON sample.activity_id = winning.window_activity_id
        AND sample.user_id = winning.window_user_id
        AND sample.sample_index >= winning.window_start_sample_index
        AND sample.sample_index <= winning.window_end_endpoint_index
      GROUP BY winning.window_activity_id, winning.window_user_id,
        winning.window_duration_seconds, winning.window_start_sample_index,
        winning.window_observed_samples
    ),
    curve_rows AS (
      SELECT *, multiIf(
        arrayExists(kind -> kind = 'estimated', kinds), 'estimated',
        arrayAll(kind -> kind = 'direct', kinds), 'direct',
        'unknown'
      ) AS power_measurement_kind
      FROM winning_evidence
    )
    SELECT
      toString(curve_rows.evidence_activity_id) AS result_activity_id,
      toString(toDate(toTimeZone(curve_rows.evidence_started_at, {timezone:String}))) AS result_activity_date,
      formatDateTime(curve_rows.evidence_started_at, '%Y-%m-%dT%H:%i:%S.%fZ', 'UTC') AS result_started_at,
      curve_rows.evidence_canonical_type AS result_canonical_type,
      curve_rows.evidence_duration_seconds AS result_duration_seconds,
      curve_rows.evidence_best_power AS result_best_power,
      curve_rows.evidence_start_offset_seconds AS result_start_offset_seconds,
      curve_rows.evidence_observed_samples AS result_observed_samples,
      curve_rows.evidence_median_sample_interval_seconds AS result_median_sample_interval_seconds,
      curve_rows.evidence_largest_gap_seconds AS result_largest_gap_seconds,
      curve_rows.coverage_pct AS result_coverage_pct,
      curve_rows.power_measurement_kind AS result_power_measurement_kind,
      curve_rows.source_providers AS result_source_providers,
      curve_rows.source_devices AS result_source_devices,
      result_activity.member_activity_ids AS result_member_activity_ids
    FROM curve_rows
    INNER JOIN selected_activities AS result_activity
      ON result_activity.activity_id = curve_rows.evidence_activity_id
      AND result_activity.user_id = curve_rows.evidence_user_id
    ) AS custom_curve
    WHERE 1 = 1 ${cursorFilter}
    ${suffix}
    SETTINGS prefer_column_name_to_alias = 1`;
}

function sortRows(left: CurveRow, right: CurveRow): number {
  return (
    left.duration_seconds - right.duration_seconds ||
    right.best_power - left.best_power ||
    right.started_at.localeCompare(left.started_at) ||
    left.activity_id.localeCompare(right.activity_id)
  );
}

function cursorShape(input: CyclingPowerCurveInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        startDate: input.startDate,
        endDate: input.endDate,
        durationsSeconds: input.durationsSeconds,
        modalities: input.modalities,
        providers: input.providers,
      }),
    )
    .digest("base64url")
    .slice(0, 22);
}

function decodeCursor(cursor: string | null, userId: string, shape: string): CurveCursor | null {
  if (!cursor) return null;
  try {
    const parsed = cursorSchema.parse(
      JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")),
    );
    if (parsed.userId !== userId || parsed.shape !== shape) {
      throw new Error("Cursor binding mismatch");
    }
    return parsed;
  } catch {
    throw new Error("Invalid cycling power-curve cursor");
  }
}

function encodeCursor(row: CurveRow, userId: string, shape: string): string {
  return Buffer.from(
    JSON.stringify({
      version: 1,
      userId,
      shape,
      duration: row.duration_seconds,
      watts: row.best_power,
      startedAt: row.started_at,
      activityId: row.activity_id,
    } satisfies CurveCursor),
    "utf8",
  ).toString("base64url");
}

function qualityFor(row: CurveRow): CyclingPowerCurveEffort["quality"] {
  const reasons: string[] = [];
  if (row.coverage_pct === null) reasons.push("Coverage was not recorded for this row");
  if (row.median_sample_interval_seconds === null) {
    reasons.push("Sample resolution was not recorded for this row");
  }
  if (row.largest_gap_seconds === null) reasons.push("Largest sample gap was not recorded");
  if (row.power_measurement_kind === "unknown" || row.power_measurement_kind === null) {
    reasons.push("Power measurement method is unknown");
  }
  const complete = reasons.length === 0 && (row.coverage_pct ?? 0) >= 99;
  return {
    status:
      complete && row.power_measurement_kind === "direct"
        ? "high"
        : reasons.length
          ? "limited"
          : "moderate",
    reasons,
    observed_samples: row.observed_samples,
    coverage_pct: row.coverage_pct,
    continuity_tolerance_seconds:
      row.median_sample_interval_seconds === null
        ? null
        : Math.max(5, row.median_sample_interval_seconds * 2),
    median_sample_interval_seconds: row.median_sample_interval_seconds,
    largest_gap_seconds: row.largest_gap_seconds,
  };
}

export class CyclingPowerCurveRepository {
  readonly #store: Pick<ActivitySensorStore, "query">;
  readonly #userId: string;
  readonly #timezone: string;

  constructor(store: Pick<ActivitySensorStore, "query">, userId: string, timezone: string) {
    this.#store = store;
    this.#userId = userId;
    this.#timezone = timezone;
  }

  async listRange(input: CyclingPowerCurveInput): Promise<CyclingPowerCurvePage> {
    if (input.durationsSeconds.length > 32) {
      throw new Error("At most 32 power-curve durations may be requested");
    }
    const shape = cursorShape(input);
    const cursor = decodeCursor(input.cursor, this.#userId, shape);
    const modelDurations = input.durationsSeconds.filter((duration) =>
      MODEL_DURATIONS.has(duration),
    );
    const customDurations = input.durationsSeconds.filter(
      (duration) => !MODEL_DURATIONS.has(duration),
    );
    const params = {
      userId: this.#userId,
      timezone: this.#timezone,
      startDate: input.startDate,
      endDate: input.endDate,
      modalities: input.modalities,
      providers: input.providers,
      pageLimit: input.limit + 1,
      ...(cursor
        ? {
            cursorDuration: cursor.duration,
            cursorWatts: cursor.watts,
            cursorStartedAt: cursor.startedAt,
            cursorActivityId: cursor.activityId,
          }
        : {}),
    };

    const bestRows: CurveRow[] = [];
    if (modelDurations.length) {
      bestRows.push(
        ...(await this.#store.query(curveRowSchema, standardSql("bests", null), {
          ...params,
          durations: modelDurations,
        })),
      );
    }
    if (customDurations.length) {
      bestRows.push(
        ...(
          await this.#store.query(customCurveRowSchema, customSql("bests", null), {
            ...params,
            durations: customDurations,
          })
        ).map(normalizeCustomCurveRow),
      );
    }

    const pageRows: CurveRow[] = [];
    if (input.includeActivityCurve && modelDurations.length) {
      pageRows.push(
        ...(await this.#store.query(curveRowSchema, standardSql("page", cursor), {
          ...params,
          durations: modelDurations,
        })),
      );
    }
    if (input.includeActivityCurve && customDurations.length) {
      pageRows.push(
        ...(
          await this.#store.query(customCurveRowSchema, customSql("page", cursor), {
            ...params,
            durations: customDurations,
          })
        ).map(normalizeCustomCurveRow),
      );
    }

    const weights = await this.#store.query(
      weightRowSchema,
      `/* power-curve:weights */
        SELECT
          toString(toDate(toTimeZone(body.recorded_at, {timezone:String}))) AS date,
          formatDateTime(body.recorded_at, '%Y-%m-%dT%H:%i:%S.%fZ', 'UTC') AS recorded_at,
          body.weight_kg,
          body.provider_id,
          body.external_id
        FROM analytics.v_body_measurement AS body
        WHERE body.user_id = {userId:UUID}
          AND body.weight_kg IS NOT NULL
          AND body.weight_kg > 0
          AND toDate(toTimeZone(body.recorded_at, {timezone:String})) BETWEEN
            addDays(toDate({startDate:String}), -30)
            AND addDays(toDate({endDate:String}), 30)
        ORDER BY body.recorded_at ASC
        SETTINGS prefer_column_name_to_alias = 1`,
      params,
    );
    const weightObservations: DirectWeightObservation[] = weights.map((weight) => ({
      date: weight.date,
      recordedAt: weight.recorded_at,
      valueKg: weight.weight_kg,
      observationType: "body_weight",
      measurementKind: "direct",
      provider: weight.provider_id,
      sourceRecordId: weight.external_id,
    }));
    const toEffort = (row: CurveRow): CyclingPowerCurveEffort => {
      const weight = selectNearbyWeight(row.activity_date, weightObservations);
      return {
        duration_seconds: row.duration_seconds,
        watts: row.best_power,
        watts_per_kg:
          weight.value_kg === null
            ? null
            : Math.round((row.best_power / weight.value_kg) * 1000) / 1000,
        watts_per_kg_reason: weight.value_kg === null ? weight.reason : null,
        weight,
        activity_id: row.activity_id,
        date: row.activity_date,
        started_at: row.started_at,
        start_offset_seconds: row.start_offset_seconds,
        canonical_type: row.canonical_type,
        power_kind: row.power_measurement_kind ?? "unknown",
        source_providers: row.source_providers,
        source_devices: row.source_devices,
        member_activity_ids: row.member_activity_ids,
        quality: qualityFor(row),
      };
    };

    bestRows.sort(sortRows);
    pageRows.sort(sortRows);
    const hasMore = pageRows.length > input.limit;
    const visiblePage = pageRows.slice(0, input.limit);
    const finalRow = visiblePage.at(-1);
    return {
      start_date: input.startDate,
      end_date: input.endDate,
      durations_seconds: input.durationsSeconds,
      bests: bestRows.map(toEffort),
      activity_curve: visiblePage.map(toEffort),
      next_cursor: hasMore && finalRow ? encodeCursor(finalRow, this.#userId, shape) : null,
    };
  }
}
