import { z } from "zod";
import type { loadCyclingEffortMetrics } from "./cycling-effort-metrics.ts";
import {
  buildActivitySourceSummary,
  buildEquivalenceEvidence,
  buildMovingDuration,
  buildRouteContext,
  buildSampleSourceSummary,
  hasObservedCyclingSensorData,
} from "./performance-comparison-context.ts";
import type {
  ComparisonIdentityRow,
  PerformanceComparisonIdentity,
} from "./performance-comparison-identity.ts";
import {
  type ClimbingComparisonRow,
  computeClimbingComparisonMetrics,
  computeStrengthComparisonMetrics,
  type StrengthComparisonRow,
} from "./performance-comparison-modality-metrics.ts";
import { isIdentityEquivalence, type ResolvedEquivalence } from "./performance-comparison-types.ts";

export const performanceSensorRowSchema = z.object({
  activity_id: z.uuid(),
  average_power: z.coerce.number().nullable(),
  normalized_power: z.coerce.number().nullable(),
  average_heart_rate: z.coerce.number().nullable(),
  max_heart_rate: z.coerce.number().nullable(),
  average_cadence: z.coerce.number().nullable(),
  distance_meters: z.coerce.number().nullable(),
  elevation_gain_meters: z.coerce.number().nullable(),
  average_temperature_c: z.coerce.number().nullable(),
  sample_source_providers: z.array(z.string()),
  sample_device_ids: z.array(z.string()),
  sample_count: z.coerce.number().int().nonnegative().nullable(),
  power_sample_count: z.coerce.number().int().nonnegative().nullable(),
  heart_rate_sample_count: z.coerce.number().int().nonnegative().nullable(),
});

export const performanceClimbingRowSchema = z.object({
  activity_id: z.uuid(),
  entry_id: z.uuid(),
  entry_activity_id: z.uuid(),
  entry_provider: z.string(),
  external_id: z.string().nullable(),
  climb_type: z.string(),
  grade_system: z.string(),
  grade: z.string(),
  sent: z.boolean().nullable(),
  attempt_count: z.coerce.number().int().positive().nullable(),
  lead: z.boolean().nullable(),
  wall_angle_degrees: z.coerce.number().nullable(),
  route_name: z.string().nullable(),
  location_name: z.string().nullable(),
});

export const performanceStrengthRowSchema = z.object({
  activity_id: z.uuid(),
  set_id: z.uuid(),
  set_activity_id: z.uuid(),
  set_provider: z.string(),
  exercise_id: z.uuid(),
  exercise_index: z.coerce.number().int().optional().default(0),
  set_index: z.coerce.number().int().optional().default(0),
  set_type: z.string().nullable(),
  weight_kg: z.coerce.number().nullable(),
  reps: z.coerce.number().int().nullable(),
  rpe: z.coerce.number().nullable(),
});

type SensorRow = z.infer<typeof performanceSensorRowSchema>;
type RouteMatch = Awaited<ReturnType<PerformanceComparisonIdentity["routeEvidence"]>>[number];
type BenchmarkRow = Awaited<ReturnType<PerformanceComparisonIdentity["benchmark"]>>[number];
type EffortRow = Awaited<ReturnType<typeof loadCyclingEffortMetrics>>[number];

export interface PerformanceActivityRow {
  activity_id: string;
  canonical_type: string;
  activity_name: string | null;
  modality: string | null;
  started_at: string;
  ended_at: string | null;
  local_date: string;
  source_providers: string[];
  source_external_ids: Array<{
    providerId: string;
    externalId: string;
    memberActivityId?: string;
    subsource?: string | null;
  }> | null;
  member_activity_ids: string[];
  timezone: string | null;
  start_utc_offset_minutes: number | null;
  local_time_source: string;
  date_was_authoritative: boolean;
  source_raw_evidence: Array<{
    sourceActivityId: string;
    provider: string;
    providerType: string;
    sourceActivityName: string | null;
    raw: Record<string, unknown> | null;
  }>;
  exercise_ids: string[];
  climb_identities: Array<{
    climbType: string;
    gradeSystem: string;
    grade: string;
    routeName: string;
    locationName: string;
    lead: boolean | null;
  }>;
}

function round(value: number, digits = 3): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

export function performanceDurationSeconds(row: PerformanceActivityRow): number | null {
  if (row.ended_at === null) return null;
  const value = (Date.parse(row.ended_at) - Date.parse(row.started_at)) / 1000;
  return Number.isFinite(value) && value >= 0 ? round(value, 0) : null;
}

function delta(candidate: number | null, baseline: number | null): number | null {
  return candidate === null || baseline === null ? null : round(candidate - baseline);
}

function groupRows<T extends { activity_id: string }>(rows: T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    grouped.set(row.activity_id, [...(grouped.get(row.activity_id) ?? []), row]);
  }
  return grouped;
}

/** Materialize each performance and its deltas once from already-loaded source rows. */
export function buildPerformanceComparisonRows(input: {
  pageRows: PerformanceActivityRow[];
  baseline: PerformanceActivityRow;
  equivalence: ResolvedEquivalence;
  identityKind: string;
  identityValue: string;
  matchingIdentitiesByActivity: Map<string, ComparisonIdentityRow[]>;
  routeMatches: RouteMatch[];
  benchmarkRows: BenchmarkRow[];
  effortRows: EffortRow[];
  sensorRows: SensorRow[];
  climbingRows: ClimbingComparisonRow[];
  strengthRows: StrengthComparisonRow[];
  timezone: string;
  evidenceFor: (
    activityId?: string,
  ) => ReturnType<typeof import("./performance-comparison-identity.ts").describeComparisonEvidence>;
}) {
  const modelKey = isIdentityEquivalence(input.equivalence.key) ? input.equivalence.key : null;
  const effortsByActivity = new Map(input.effortRows.map((row) => [row.activityId, row.metrics]));
  const sensorsByActivity = new Map(input.sensorRows.map((row) => [row.activity_id, row]));
  const climbsByActivity = groupRows(input.climbingRows);
  const strengthByActivity = groupRows(input.strengthRows);
  const activities = [
    ...new Map([...input.pageRows, input.baseline].map((row) => [row.activity_id, row])).values(),
  ];
  const valuesByActivity = new Map(
    activities.map((row) => {
      const sensor = sensorsByActivity.get(row.activity_id);
      const effort = effortsByActivity.get(row.activity_id);
      const cycling =
        row.canonical_type !== "cycling"
          ? null
          : {
              average_power_watts: effort?.workout.power.averageWatts ?? null,
              normalized_power_watts: effort?.workout.power.normalizedWatts ?? null,
              average_heart_rate_bpm: effort?.workout.heartRate.averageBpm ?? null,
              max_heart_rate_bpm: effort?.workout.heartRate.maximumBpm ?? null,
              average_cadence_rpm: effort?.workout.cadence.averageRpm ?? null,
              power_to_heart_rate_ratio:
                effort?.workout.aerobicEfficiency.powerToHeartRateRatio ?? null,
              distance_meters: effort?.movement.distanceMeters ?? null,
              elevation_gain_meters: effort?.movement.elevationGainMeters ?? null,
              sample_coverage: {
                total_samples: null,
                total_samples_unavailable_reason:
                  "Unique timestamp count across channels is unavailable; per-stream sample counts are supplied.",
                power_samples: effort?.streamQuality.power.observedSamples ?? null,
                heart_rate_samples: effort?.streamQuality.heartRate.observedSamples ?? null,
                status: effort !== undefined ? ("available" as const) : ("not_available" as const),
              },
            };
      return [
        row.activity_id,
        {
          duration: performanceDurationSeconds(row),
          averageTemperatureC:
            row.canonical_type === "cycling"
              ? (effort?.environment.averageTemperatureC ?? null)
              : (sensor?.average_temperature_c ?? null),
          effort: effort ?? null,
          cycling,
          climbing: computeClimbingComparisonMetrics(climbsByActivity.get(row.activity_id) ?? []),
          strength: computeStrengthComparisonMetrics(strengthByActivity.get(row.activity_id) ?? []),
        },
      ] as const;
    }),
  );
  const baselineValues = valuesByActivity.get(input.baseline.activity_id);
  if (!baselineValues) throw new Error("Baseline performance values were not materialized");
  const baselineMovingDuration = buildMovingDuration(input.baseline.source_raw_evidence);
  const observedCyclingActivityIds = new Set(
    activities
      .filter((row) => {
        const effort = effortsByActivity.get(row.activity_id);
        return hasObservedCyclingSensorData(
          row.canonical_type,
          effort
            ? {
                sample_count: Math.max(
                  effort.streamQuality.cadence.observedSamples,
                  effort.streamQuality.speed.observedSamples,
                ),
                power_sample_count: effort.streamQuality.power.observedSamples,
                heart_rate_sample_count: effort.streamQuality.heartRate.observedSamples,
              }
            : undefined,
        );
      })
      .map((row) => row.activity_id),
  );

  const performances = input.pageRows.map((row) => {
    const current = valuesByActivity.get(row.activity_id);
    if (!current)
      throw new Error(`Performance values were not materialized for ${row.activity_id}`);
    const climbingForActivity = climbsByActivity.get(row.activity_id) ?? [];
    const strengthForActivity = strengthByActivity.get(row.activity_id) ?? [];
    const legacyEvidence = buildEquivalenceEvidence(input.equivalence.key, {
      activityId: row.activity_id,
      activityName: row.activity_name,
      sourceRawEvidence: row.source_raw_evidence,
      climbingRows: climbingForActivity,
      strengthRows: strengthForActivity,
    });
    const matchingIdentities = input.matchingIdentitiesByActivity.get(row.activity_id) ?? [];
    const routeMatch = input.routeMatches.find((match) => match.activityId === row.activity_id);
    const benchmark = input.benchmarkRows.find(
      (member) => member.canonical_activity_id === row.activity_id,
    );
    const extraEvidence = matchingIdentities.map((identity) => ({
      evidence_type: "identity_read_model" as const,
      provider: identity.source_provider,
      value: identity.value,
      field: identity.source_field,
      provider_type: null,
      source_activity_id: identity.source_activity_id,
      source_record_id: null,
      identity_evidence: identity,
    }));
    const assertionBase = {
      provider: null,
      value: input.identityValue,
      field: null,
      provider_type: null,
      source_activity_id: row.activity_id,
      source_record_id: null,
    };
    const assertionEvidence = [
      ...(routeMatch?.geometry
        ? [
            {
              ...assertionBase,
              evidence_type: "route_geometry" as const,
              assertion_evidence: { anchor_activity_id: routeMatch.anchor_activity_id },
            },
          ]
        : []),
      ...(benchmark
        ? [
            {
              ...assertionBase,
              evidence_type: "user_benchmark_membership" as const,
              assertion_evidence: { ...benchmark },
            },
          ]
        : []),
    ];
    const allEvidence = [...extraEvidence, ...assertionEvidence];
    const equivalenceEvidence = modelKey
      ? {
          items: allEvidence.slice(0, 100),
          count: allEvidence.length,
          truncated: allEvidence.length > 100,
        }
      : legacyEvidence;
    const identityEvidence = input.evidenceFor(row.activity_id);
    const movingDuration = buildMovingDuration(row.source_raw_evidence);
    const flags = [
      `${identityEvidence.strength}_equivalence`,
      ...(routeMatch?.geometry && !routeMatch.geometry.matched ? ["route_geometry_rejected"] : []),
      ...(routeMatch && !routeMatch.geometry ? ["route_geometry_unavailable"] : []),
      ...(current.effort?.quality.reasons ?? []),
      ...(current.duration === null ? ["duration_unavailable"] : []),
      ...(row.local_time_source === "unknown" ? ["timezone_assumed_from_analysis_context"] : []),
      ...(row.canonical_type === "cycling" && !observedCyclingActivityIds.has(row.activity_id)
        ? ["cycling_sensor_summary_unavailable"]
        : []),
      ...((current.strength?.suspicious_sets ?? 0) > 0
        ? ["contains_suspicious_strength_sets_excluded_from_metrics"]
        : []),
      ...(current.strength?.volume_status === "partial"
        ? ["strength_volume_coverage_partial"]
        : []),
      ...(current.strength?.estimated_one_rep_max_status === "partial"
        ? ["strength_estimated_one_rep_max_coverage_partial"]
        : []),
      ...((current.climbing?.excluded_ambiguous_entries ?? 0) > 0
        ? ["contains_ambiguous_climbing_entries_excluded_from_metrics"]
        : []),
      ...(current.climbing?.attempts_status === "partial"
        ? ["climbing_attempt_coverage_partial"]
        : []),
      ...(current.climbing?.outcomes_status === "partial"
        ? ["climbing_outcome_coverage_partial"]
        : []),
      ...(movingDuration.status === "conflicting" ? ["moving_duration_sources_conflict"] : []),
      ...(equivalenceEvidence.count === 0 ? ["equivalence_evidence_unavailable"] : []),
    ];
    return {
      activity_id: row.activity_id,
      date: row.local_date,
      started_at: row.started_at,
      name: row.activity_name,
      canonical_type: row.canonical_type,
      modality: row.modality,
      duration_seconds: current.duration,
      moving_duration: movingDuration,
      route: {
        ...buildRouteContext(input.equivalence.key, row.activity_name),
        ...(input.identityKind === "provider_route"
          ? {
              status: identityEvidence.strength,
              provider: identityEvidence.identity.namespace,
              activity_name: row.activity_name,
              evidence: "identity_read_model" as const,
            }
          : routeMatch
            ? { status: "strong_inferred" as const, evidence: "route_geometry" as const }
            : {}),
        geometry: routeMatch?.geometry ?? null,
        quality: routeMatch?.quality ?? null,
        anchor_quality: routeMatch?.anchor_quality ?? null,
        geometry_unavailable_reason: routeMatch
          ? routeMatch.geometry_unavailable_reason
          : "No geometry comparison was performed for this identity.",
        source_providers: routeMatch?.source_providers ?? [],
        source_devices: routeMatch?.source_devices ?? [],
        anchor_activity_id: routeMatch?.anchor_activity_id ?? null,
        anchor_source_providers: routeMatch?.anchor_source_providers ?? [],
        anchor_source_devices: routeMatch?.anchor_source_devices ?? [],
      },
      identity: identityEvidence,
      equivalence_evidence: equivalenceEvidence.items,
      equivalence_evidence_count: equivalenceEvidence.count,
      equivalence_evidence_truncated: equivalenceEvidence.truncated,
      is_baseline: row.activity_id === input.baseline.activity_id,
      ...buildActivitySourceSummary(
        row.source_providers,
        row.source_external_ids ?? [],
        row.member_activity_ids,
      ),
      timezone: {
        value: row.timezone,
        start_utc_offset_minutes: row.start_utc_offset_minutes,
        local_time_source: row.local_time_source,
        analysis_timezone: input.timezone,
        assumed: !row.date_was_authoritative,
      },
      metrics: {
        cycling: current.cycling,
        cycling_effort: current.effort,
        cycling_effort_unavailable_reason: current.effort
          ? null
          : row.canonical_type === "cycling"
            ? "Valid elapsed duration is required to calculate cycling effort metrics."
            : "Activity is not cycling.",
        climbing: current.climbing,
        strength: current.strength,
        environment: {
          average_temperature_c: current.averageTemperatureC,
          status:
            current.averageTemperatureC == null
              ? ("not_available" as const)
              : ("available" as const),
          value_kind: "calculated_from_deduped_samples" as const,
        },
      },
      delta_to_baseline: {
        duration_seconds: delta(current.duration, baselineValues.duration),
        moving_duration_seconds: delta(
          movingDuration.status === "available" ? movingDuration.seconds : null,
          baselineMovingDuration.status === "available" ? baselineMovingDuration.seconds : null,
        ),
        average_power_watts: delta(
          current.cycling?.average_power_watts ?? null,
          baselineValues.cycling?.average_power_watts ?? null,
        ),
        normalized_power_watts: delta(
          current.cycling?.normalized_power_watts ?? null,
          baselineValues.cycling?.normalized_power_watts ?? null,
        ),
        average_heart_rate_bpm: delta(
          current.cycling?.average_heart_rate_bpm ?? null,
          baselineValues.cycling?.average_heart_rate_bpm ?? null,
        ),
        average_cadence_rpm: delta(
          current.cycling?.average_cadence_rpm ?? null,
          baselineValues.cycling?.average_cadence_rpm ?? null,
        ),
        power_to_heart_rate_ratio: delta(
          current.cycling?.power_to_heart_rate_ratio ?? null,
          baselineValues.cycling?.power_to_heart_rate_ratio ?? null,
        ),
        distance_meters: delta(
          current.cycling?.distance_meters ?? null,
          baselineValues.cycling?.distance_meters ?? null,
        ),
        elevation_gain_meters: delta(
          current.cycling?.elevation_gain_meters ?? null,
          baselineValues.cycling?.elevation_gain_meters ?? null,
        ),
        average_temperature_c: delta(
          current.averageTemperatureC,
          baselineValues.averageTemperatureC,
        ),
        climbing_attempts: delta(
          current.climbing?.attempts_status === "complete" &&
            baselineValues.climbing?.attempts_status === "complete"
            ? current.climbing.attempts
            : null,
          current.climbing?.attempts_status === "complete" &&
            baselineValues.climbing?.attempts_status === "complete"
            ? baselineValues.climbing.attempts
            : null,
        ),
        climbing_sends: delta(
          current.climbing?.outcomes_status === "complete" &&
            baselineValues.climbing?.outcomes_status === "complete"
            ? current.climbing.sends
            : null,
          current.climbing?.outcomes_status === "complete" &&
            baselineValues.climbing?.outcomes_status === "complete"
            ? baselineValues.climbing.sends
            : null,
        ),
        strength_volume_kg_reps: delta(
          current.strength?.volume_status === "complete" &&
            baselineValues.strength?.volume_status === "complete"
            ? current.strength.valid_volume_kg_reps
            : null,
          current.strength?.volume_status === "complete" &&
            baselineValues.strength?.volume_status === "complete"
            ? baselineValues.strength.valid_volume_kg_reps
            : null,
        ),
        strength_estimated_one_rep_max_kg: delta(
          current.strength?.estimated_one_rep_max_status === "complete" &&
            baselineValues.strength?.estimated_one_rep_max_status === "complete"
            ? current.strength.best_estimated_one_rep_max_kg
            : null,
          current.strength?.estimated_one_rep_max_status === "complete" &&
            baselineValues.strength?.estimated_one_rep_max_status === "complete"
            ? baselineValues.strength.best_estimated_one_rep_max_kg
            : null,
        ),
      },
      quality: { comparable: identityEvidence.strength !== "weak_similarity", flags },
      provenance: {
        value_kind: "mixed" as const,
        activity_deduplication: "fitness.v_activity" as const,
        sensor_deduplication:
          "analytics.activity_summary_rows/activity_sensor_sample FINAL" as const,
        ...buildSampleSourceSummary(
          (current.effort
            ? [
                ...new Set(
                  Object.values(current.effort.streamQuality).flatMap((stream) =>
                    stream.evidence.flatMap((evidence) =>
                      evidence.providerId ? [evidence.providerId] : [],
                    ),
                  ),
                ),
              ].sort()
            : undefined) ??
            sensorsByActivity.get(row.activity_id)?.sample_source_providers ??
            [],
          current.effort?.provenance.sourceDevices ??
            sensorsByActivity.get(row.activity_id)?.sample_device_ids ??
            [],
        ),
      },
    };
  });

  return { performances, observedCyclingActivityIds };
}
