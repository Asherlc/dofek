import type { CyclingEffortRequest } from "./cycling-effort-metrics.ts";
import type {
  ClimbingComparisonRow,
  StrengthComparisonRow,
} from "./performance-comparison-modality-metrics.ts";
import type { PerformanceEquivalence } from "./performance-comparison-types.ts";

/** Translate authorized canonical activity evidence to the shared cycling input. */
export function cyclingEffortRequest(activity: {
  activity_id: string;
  member_activity_ids: string[];
  started_at: string;
  ended_at: string | null;
  local_date: string;
  source_providers: string[];
  source_raw_evidence: SourceRawPerformanceEvidence[];
}): CyclingEffortRequest {
  const duration =
    activity.ended_at == null
      ? NaN
      : (Date.parse(activity.ended_at) - Date.parse(activity.started_at)) / 1000;
  if (!Number.isFinite(duration) || duration < 0) {
    throw new Error(`Cycling activity ${activity.activity_id} requires a valid elapsed duration`);
  }
  return {
    activity_id: activity.activity_id,
    member_activity_ids: activity.member_activity_ids,
    started_at: activity.started_at,
    activityDate: activity.local_date,
    durationSeconds: duration,
    sourceProviders: activity.source_providers,
    movingDuration: buildMovingDuration(activity.source_raw_evidence),
  };
}

export const PELOTON_WORKOUT_KEYS = ["pelotonClassId"] as const;

export interface SourceRawPerformanceEvidence {
  sourceActivityId: string;
  provider: string;
  providerType: string;
  sourceActivityName: string | null;
  raw: Record<string, unknown> | null;
}

interface PerformanceContextInput {
  activityId: string;
  activityName: string | null;
  sourceRawEvidence: SourceRawPerformanceEvidence[];
  climbingRows: ClimbingComparisonRow[];
  strengthRows: StrengthComparisonRow[];
}

interface CyclingSensorAvailability {
  sample_count: number | null;
  power_sample_count: number | null;
  heart_rate_sample_count: number | null;
}

/** A summary has observed cycling data only when at least one relevant sample count is positive. */
export function hasObservedCyclingSensorData(
  canonicalType: string,
  sensor: CyclingSensorAvailability | undefined,
): boolean {
  if (canonicalType !== "cycling" || sensor === undefined) return false;
  return [sensor.sample_count, sensor.power_sample_count, sensor.heart_rate_sample_count].some(
    (value) => value !== null && value > 0,
  );
}

function normalized(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function rawKeys(key: PerformanceEquivalence): readonly string[] {
  if (key.kind === "provider_workout_id") return PELOTON_WORKOUT_KEYS;
  return [];
}

/** Return bounded, source-record-level evidence explaining why an activity matched. */
export function buildEquivalenceEvidence(
  key: PerformanceEquivalence,
  input: PerformanceContextInput,
) {
  const items: Array<{
    evidence_type:
      | "provider_raw_field"
      | "cycling_route_name_provider_type"
      | "standardized_test_name_provider_type"
      | "climbing_entry"
      | "strength_set"
      | "canonical_activity_name";
    provider: string | null;
    value: string;
    field: string | null;
    provider_type: string | null;
    source_activity_id: string;
    source_record_id: string | null;
  }> = [];
  if (key.kind === "provider_workout_id") {
    for (const source of input.sourceRawEvidence) {
      if (source.provider !== key.provider || source.raw === null) continue;
      for (const field of rawKeys(key)) {
        const value = source.raw[field];
        const identity =
          typeof value === "string"
            ? value.trim()
            : typeof value === "number" && Number.isFinite(value)
              ? String(value)
              : null;
        if (identity === key.value) {
          items.push({
            evidence_type: "provider_raw_field",
            provider: source.provider,
            value: identity,
            field,
            provider_type: source.providerType,
            source_activity_id: source.sourceActivityId,
            source_record_id: null,
          });
        }
      }
    }
  } else if (key.kind === "cycling_route" || key.kind === "standardized_test") {
    for (const source of input.sourceRawEvidence) {
      if (
        source.provider !== key.provider ||
        normalized(source.providerType) !== normalized(key.providerType) ||
        source.sourceActivityName === null ||
        normalized(source.sourceActivityName) !== normalized(key.activityName)
      ) {
        continue;
      }
      items.push({
        evidence_type:
          key.kind === "cycling_route"
            ? "cycling_route_name_provider_type"
            : "standardized_test_name_provider_type",
        provider: source.provider,
        value: source.sourceActivityName,
        field: "fitness.activity.name + fitness.activity.provider_type",
        provider_type: source.providerType,
        source_activity_id: source.sourceActivityId,
        source_record_id: null,
      });
    }
  } else if (key.kind === "climb") {
    for (const row of input.climbingRows) {
      items.push({
        evidence_type: "climbing_entry",
        provider: row.entry_provider,
        value: `${row.climb_type}:${row.grade_system}:${row.grade}:${row.route_name ?? ""}:${row.location_name ?? ""}:lead=${String(row.lead)}`,
        field: null,
        provider_type: null,
        source_activity_id: row.entry_activity_id,
        source_record_id: row.entry_id,
      });
    }
  } else if (key.kind === "strength_exercise_id") {
    for (const row of input.strengthRows) {
      items.push({
        evidence_type: "strength_set",
        provider: row.set_provider,
        value: row.exercise_id,
        field: "exercise_id",
        provider_type: null,
        source_activity_id: row.set_activity_id,
        source_record_id: row.set_id,
      });
    }
  } else {
    items.push({
      evidence_type: "canonical_activity_name",
      provider: null,
      value: input.activityName ?? key.value,
      field: "fitness.v_activity.name",
      provider_type: null,
      source_activity_id: input.activityId,
      source_record_id: null,
    });
  }
  const deduped = items.filter(
    (item, index, all) =>
      all.findIndex((candidate) => JSON.stringify(candidate) === JSON.stringify(item)) === index,
  );
  return { items: deduped.slice(0, 100), count: deduped.length, truncated: deduped.length > 100 };
}

const MOVING_DURATION_KEYS = ["moving_time", "movingTime", "movingTimeSeconds"] as const;

/** Preserve provider-reported moving duration and surface conflicting providers explicitly. */
export function buildMovingDuration(sourceEvidence: SourceRawPerformanceEvidence[]) {
  const evidence = sourceEvidence.flatMap((source) => {
    if (source.raw === null) return [];
    return MOVING_DURATION_KEYS.flatMap((field) => {
      const raw = source.raw?.[field];
      const seconds =
        typeof raw === "number"
          ? raw
          : typeof raw === "string" && raw.trim().length > 0
            ? Number(raw)
            : NaN;
      if (!Number.isFinite(seconds) || seconds < 0) return [];
      return [
        {
          provider: source.provider,
          source_activity_id: source.sourceActivityId,
          raw_field: field,
          seconds: Math.round(seconds),
          value_kind: "provider_reported" as const,
        },
      ];
    });
  });
  const deduped = evidence.filter(
    (item, index, all) =>
      all.findIndex((candidate) => JSON.stringify(candidate) === JSON.stringify(item)) === index,
  );
  const values = [...new Set(deduped.map((item) => item.seconds))];
  return {
    seconds: values.length === 1 ? (values[0] ?? null) : null,
    status:
      values.length === 0
        ? ("not_available" as const)
        : values.length === 1
          ? ("available" as const)
          : ("conflicting" as const),
    evidence: deduped.slice(0, 20),
    evidence_count: deduped.length,
    evidence_truncated: deduped.length > 20,
  };
}

export function buildRouteContext(key: PerformanceEquivalence, activityName: string | null) {
  return key.kind === "cycling_route"
    ? {
        status: "caller_asserted" as const,
        provider: key.provider,
        activity_name: activityName,
        provider_type: key.providerType,
        evidence: "caller_asserted_activity_name_provider_type" as const,
      }
    : {
        status: "not_available" as const,
        provider: null,
        activity_name: null,
        provider_type: null,
        evidence: "comparison_not_keyed_by_route" as const,
      };
}

/** Bound duplicate/source provenance independently of activity pagination. */
export function buildActivitySourceSummary<T>(
  providers: string[],
  externalIds: T[],
  memberActivityIds: string[],
) {
  return {
    source_providers: providers.slice(0, 100),
    source_provider_count: providers.length,
    source_external_ids: externalIds.slice(0, 100),
    source_external_id_count: externalIds.length,
    member_activity_ids: memberActivityIds.slice(0, 100),
    member_activity_id_count: memberActivityIds.length,
    activity_source_evidence_truncated:
      providers.length > 100 || externalIds.length > 100 || memberActivityIds.length > 100,
  };
}

export function buildSampleSourceSummary(providers: string[], deviceIds: string[]) {
  return {
    sample_source_providers: providers.slice(0, 100),
    sample_source_provider_count: providers.length,
    sample_device_ids: deviceIds.slice(0, 100),
    sample_device_id_count: deviceIds.length,
    sample_source_evidence_truncated: providers.length > 100 || deviceIds.length > 100,
  };
}

export const PERFORMANCE_COMPARISON_SENSOR_QUERY = `/* performance-comparison:sensors */
WITH temperature AS (
  SELECT activity_id, avg(scalar) AS average_temperature_c
  FROM analytics.activity_sensor_sample AS sensor FINAL
  WHERE user_id = {userId:UUID}
    AND is_deleted = 0
    AND channel = 'temperature'
    AND scalar IS NOT NULL
    AND has({activityIds:Array(String)}, toString(activity_id))
  GROUP BY activity_id
),
sample_provenance AS (
  SELECT
    activity_id,
    arraySort(arrayDistinct(groupArrayIf(assumeNotNull(provider_id), provider_id IS NOT NULL)))
      AS sample_source_providers,
    arraySort(arrayDistinct(groupArrayIf(assumeNotNull(device_id), device_id IS NOT NULL)))
      AS sample_device_ids
  FROM analytics.activity_sensor_sample AS sensor FINAL
  WHERE user_id = {userId:UUID}
    AND is_deleted = 0
    AND has({activityIds:Array(String)}, toString(activity_id))
  GROUP BY activity_id
)
SELECT
  toString(summary.activity_id) AS activity_id,
  summary.avg_power AS average_power,
  summary.normalized_power AS normalized_power,
  summary.avg_hr AS average_heart_rate,
  summary.max_hr AS max_heart_rate,
  summary.avg_cadence AS average_cadence,
  summary.total_distance AS distance_meters,
  summary.elevation_gain_m AS elevation_gain_meters,
  temperature.average_temperature_c,
  coalesce(sample_provenance.sample_source_providers, []) AS sample_source_providers,
  coalesce(sample_provenance.sample_device_ids, []) AS sample_device_ids,
  summary.sample_count,
  summary.power_sample_count,
  summary.hr_sample_count AS heart_rate_sample_count
FROM analytics.activity_summary_rows AS summary FINAL
LEFT JOIN temperature ON temperature.activity_id = summary.activity_id
LEFT JOIN sample_provenance ON sample_provenance.activity_id = summary.activity_id
WHERE summary.user_id = {userId:UUID}
  AND summary.is_deleted = 0
  AND has({activityIds:Array(String)}, toString(summary.activity_id))`;
