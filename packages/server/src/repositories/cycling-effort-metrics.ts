import {
  type CyclingWorkoutIntervalInput,
  type CyclingWorkoutSample,
  type CyclingWorkoutSettings,
  computeCyclingWorkoutMetrics,
  resampleCyclingStream,
} from "@dofek/training/cycling-workout-metrics";
import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema, timestampStringSchema } from "../lib/typed-sql.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";
import {
  type ComparableInterval,
  inferIntervalResult,
  mergeComparableIntervals,
} from "./intervals-repository.ts";
import { type DirectWeightObservation, selectNearbyWeight } from "./nearby-weight.ts";
import { loadDirectWeightObservations } from "./nearby-weight-repository.ts";
import type { buildMovingDuration } from "./performance-comparison-context.ts";
import { SportSettingsRepository, type SportSettingsRow } from "./sport-settings-repository.ts";

export interface CyclingEffortSample extends CyclingWorkoutSample {
  speedMetersPerSecond?: number | null;
  altitudeMeters?: number | null;
  temperatureC?: number | null;
}

export interface CyclingEffortContext {
  durationSeconds: number;
  activityDate: string;
  settingsHistory: SportSettingsRow[];
  intervals: CyclingWorkoutIntervalInput[];
  weightObservations: DirectWeightObservation[];
  powerMeasurementKinds: Array<"direct" | "estimated" | "unknown">;
  sourceProviders: string[];
  sourceDevices: string[];
  movingDuration?: ReturnType<typeof buildMovingDuration>;
  distanceEvidence?: { meters: number; kind: "deduplicated_summary" };
  bestPowers?: z.infer<typeof bestPowerRowSchema>[];
  intervalEvidence?: RecordedIntervalEvidence[];
}

const streamFields = {
  power: "powerWatts",
  heartRate: "heartRateBpm",
  cadence: "cadenceRpm",
  speed: "speedMetersPerSecond",
  altitude: "altitudeMeters",
  temperature: "temperatureC",
} as const;

function cleanSamples(samples: CyclingEffortSample[], duration: number) {
  const cleaned = new Map<number, CyclingEffortSample>();
  const counts = Object.fromEntries(
    Object.keys(streamFields).map((key) => [key, { suspiciousSamples: 0, conflictingSamples: 0 }]),
  );
  for (const [stream, field] of Object.entries(streamFields)) {
    const values = new Map<number, Set<number>>();
    const count = counts[stream];
    if (!count) throw new Error("Missing stream quality counter");
    for (const sample of samples) {
      const value = sample[field];
      if (value == null) continue;
      const offset = Math.floor(sample.elapsedSeconds);
      // Physical validity only; no athlete-specific performance ceilings.
      if (
        !Number.isFinite(value) ||
        !Number.isFinite(offset) ||
        offset < 0 ||
        offset >= duration ||
        (field !== "altitudeMeters" && field !== "temperatureC" && value < 0)
      ) {
        count.suspiciousSamples++;
        continue;
      }
      const atOffset = values.get(offset) ?? new Set<number>();
      atOffset.add(value);
      values.set(offset, atOffset);
    }
    for (const [offset, distinct] of values) {
      if (distinct.size > 1) {
        count.conflictingSamples++;
        continue;
      }
      const row = cleaned.get(offset) ?? { elapsedSeconds: offset };
      row[field] = [...distinct][0] ?? null;
      cleaned.set(offset, row);
    }
  }
  return {
    samples: [...cleaned.values()].sort((a, b) => a.elapsedSeconds - b.elapsedSeconds),
    counts,
  };
}

function mean(values: Array<number | null>): number | null {
  const observed = values.filter((value): value is number => value !== null);
  return observed.length === 0
    ? null
    : observed.reduce((sum, value) => sum + value, 0) / observed.length;
}

/** Server-only composition of the existing workout algorithms and effort evidence. */
export function calculateCyclingEffortMetrics(
  samples: CyclingEffortSample[],
  context: CyclingEffortContext,
) {
  const duration = Math.max(0, Math.floor(context.durationSeconds));
  const clean = cleanSamples(samples, duration);
  const settings = effectiveSettings(context.settingsHistory, context.activityDate);
  const workout = computeCyclingWorkoutMetrics({
    durationSeconds: duration,
    samples: clean.samples,
    settings: workoutSettings(settings),
    intervals: context.intervals,
  });
  const speed = resampleCyclingStream(
    clean.samples,
    duration,
    (sample) => sample.speedMetersPerSecond,
  );
  const hr = resampleCyclingStream(clean.samples, duration, (sample) => sample.heartRateBpm);
  const signedStream = (field: "altitudeMeters" | "temperatureC") => {
    return resampleCyclingStream(clean.samples, duration, (sample) => sample[field], -Infinity);
  };
  const altitude = signedStream("altitudeMeters");
  const temperature = signedStream("temperatureC");
  const movingSpeeds = speed.values.filter((value): value is number => value != null && value > 0);
  const sampledDistance =
    speed.coverage.coveredSeconds === 0
      ? null
      : speed.values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  const summaryDistance = context.distanceEvidence?.meters;
  const validSummaryDistance =
    summaryDistance != null && Number.isFinite(summaryDistance) && summaryDistance >= 0;
  const distance = validSummaryDistance ? summaryDistance : sampledDistance;
  const providerMoving = context.movingDuration;
  const validProviderMoving =
    providerMoving?.status === "available" &&
    providerMoving.seconds != null &&
    providerMoving.seconds <= duration;
  const movingSeconds = validProviderMoving
    ? providerMoving.seconds
    : speed.coverage.coveredSeconds > 0
      ? movingSpeeds.length
      : null;
  const pairedSpeed: number[] = [];
  const pairedHr: number[] = [];
  for (let index = 0; index < duration; index++) {
    const velocity = speed.values[index];
    const heartRate = hr.values[index];
    if (velocity != null && heartRate != null && heartRate > 0) {
      pairedSpeed.push(velocity);
      pairedHr.push(heartRate);
    }
  }
  const pairedCoverage = duration > 0 && pairedSpeed.length / duration >= 0.9;
  let gain = 0;
  let loss = 0;
  let ascentSeconds = 0;
  let elevationPairs = 0;
  const altitudePoints = clean.samples.filter((sample) => sample.altitudeMeters != null);
  for (let i = 1; i < altitudePoints.length; i++) {
    const before = altitudePoints[i - 1];
    const after = altitudePoints[i];
    if (before?.altitudeMeters == null || after?.altitudeMeters == null) continue;
    const seconds = after.elapsedSeconds - before.elapsedSeconds;
    if (seconds <= 0 || seconds > 10) continue;
    const rise = after.altitudeMeters - before.altitudeMeters;
    elevationPairs++;
    if (rise > 0) {
      gain += rise;
      ascentSeconds += seconds;
    } else loss -= rise;
  }
  const weight = selectNearbyWeight(context.activityDate, context.weightObservations);
  const ftp =
    settings?.ftp != null && settings.ftp > 0 && Number.isFinite(settings.ftp)
      ? {
          value: settings.ftp,
          effectiveFrom: settings.effectiveFrom,
          sourceRecordId: settings.id,
          kind: "configured" as const,
        }
      : null;
  const ageDays = settings
    ? Math.round((Date.parse(context.activityDate) - Date.parse(settings.effectiveFrom)) / 86400000)
    : null;
  const streamQuality = {
    power: { ...workout.coverage.power, ...clean.counts.power },
    heartRate: { ...workout.coverage.heartRate, ...clean.counts.heartRate },
    cadence: { ...workout.coverage.cadence, ...clean.counts.cadence },
    speed: { ...speed.coverage, ...clean.counts.speed },
    altitude: { ...altitude.coverage, ...clean.counts.altitude },
    temperature: { ...temperature.coverage, ...clean.counts.temperature },
  };
  const reasons: string[] = [];
  if (workout.coverage.power.coveragePct < 99) reasons.push("Power coverage is incomplete");
  if (
    context.powerMeasurementKinds.length === 0 ||
    context.powerMeasurementKinds.some((kind) => kind !== "direct")
  )
    reasons.push("Power is estimated or its measurement provenance is unknown");
  if (Object.values(clean.counts).some((count) => count.suspiciousSamples > 0))
    reasons.push("Suspicious samples excluded");
  if (Object.values(clean.counts).some((count) => count.conflictingSamples > 0))
    reasons.push("Conflicting samples excluded");
  if (providerMoving?.status === "conflicting") reasons.push("Provider moving durations conflict");
  if (providerMoving?.seconds != null && !validProviderMoving)
    reasons.push("Provider moving duration exceeds elapsed duration");
  const unavailableReasons = workout.unavailableReasons.map((item) =>
    ftp == null && ["intensity_factor", "training_stress_score"].includes(item.metric)
      ? { ...item, reason: "no contemporaneous FTP" }
      : item,
  );
  const unavailable = (metric: string, reason: string) =>
    unavailableReasons.push({ metric, reason });
  if (!ftp) unavailable("power_zones", "no contemporaneous FTP");
  if (!workout.heartRateZones)
    unavailable("heart_rate_zones", "no contemporaneous threshold HR and valid zone boundaries");
  if (weight.value_kg == null) unavailable("watts_per_kg", weight.reason);
  if (!pairedCoverage)
    unavailable("speed_to_heart_rate_ratio", "paired speed and heart-rate coverage is below 90%");
  if (movingSeconds == null)
    unavailable("moving_duration", "no valid provider moving duration or covered speed samples");
  if (distance == null) unavailable("distance", "no covered speed samples");
  if (ascentSeconds === 0)
    unavailable("climb_vertical_speed", "no continuous ascending elevation windows");
  if (temperature.coverage.coveredSeconds === 0)
    unavailable("temperature", "no temperature samples");
  return {
    workout,
    thresholds: {
      ftp,
      thresholdHeartRateBpm: settings?.thresholdHr ?? null,
      ageDays,
      freshness: ftp == null ? ("unavailable" as const) : ("unverified" as const),
      freshnessReason:
        ftp == null
          ? "no contemporaneous FTP"
          : "Effective-dated configuration may be stale; physiological freshness is unverified. No expiry is inferred.",
    },
    movement: {
      elapsedSeconds: duration,
      movingSeconds,
      movingDurationKind: validProviderMoving
        ? ("provider_reported" as const)
        : movingSeconds == null
          ? ("unavailable" as const)
          : ("calculated_from_covered_speed_samples" as const),
      providerMovingDuration: providerMoving ?? null,
      distanceMeters: distance,
      distanceKind: validSummaryDistance
        ? ("deduplicated_summary" as const)
        : distance == null
          ? ("unavailable" as const)
          : ("integrated_covered_speed_samples" as const),
      averageMovingSpeedMetersPerSecond:
        validProviderMoving && movingSeconds != null && movingSeconds > 0 && validSummaryDistance
          ? summaryDistance / movingSeconds
          : mean(movingSpeeds),
      maximumSpeedMetersPerSecond:
        speed.coverage.coveredSeconds > 0
          ? Math.max(...speed.values.map((value) => value ?? 0))
          : null,
      speedToHeartRateRatio: pairedCoverage
        ? (mean(pairedSpeed) ?? 0) / (mean(pairedHr) ?? 1)
        : null,
      speedHeartRatePairedSeconds: pairedSpeed.length,
      elevationGainMeters: elevationPairs > 0 ? gain : null,
      elevationLossMeters: elevationPairs > 0 ? loss : null,
      climbVerticalSpeedMetersPerHour: ascentSeconds > 0 ? (gain / ascentSeconds) * 3600 : null,
      climbDurationSeconds: ascentSeconds,
      elevationKind: "continuous_sample_windows" as const,
    },
    weight,
    averageWattsPerKg:
      weight.value_kg != null && workout.power.averageWatts != null
        ? workout.power.averageWatts / weight.value_kg
        : null,
    normalizedWattsPerKg:
      weight.value_kg != null && workout.power.normalizedWatts != null
        ? workout.power.normalizedWatts / weight.value_kg
        : null,
    bestPowers: (context.bestPowers ?? []).map((row) => ({
      durationSeconds: row.duration_seconds,
      watts: row.best_power,
      wattsPerKg: weight.value_kg == null ? null : row.best_power / weight.value_kg,
      startOffsetSeconds: row.start_offset_seconds,
      powerKind: row.power_measurement_kind ?? "unknown",
      observedSamples: row.observed_samples,
      coveragePct: row.coverage_pct,
      largestGapSeconds: row.largest_gap_seconds,
      medianSampleIntervalSeconds: row.median_sample_interval_seconds,
    })),
    intervals: workout.intervals.map((interval) => {
      const evidence = context.intervalEvidence?.find(
        (item) =>
          item.input.startOffsetSeconds === interval.startOffsetSeconds &&
          item.input.endOffsetSeconds === interval.endOffsetSeconds,
      );
      const source =
        evidence?.interval.source ?? (interval.source === "inferred" ? "inferred" : "unknown");
      return {
        ...interval,
        source,
        evidence: evidence?.interval ?? null,
        targetPowerWatts: source === "inferred" ? null : interval.targetPowerWatts,
        completionPct: source === "inferred" ? null : interval.completionPct,
      };
    }),
    bestPowerInterpretation: {
      kind: "descriptive_observed_maxima" as const,
      maximalTest: false as const,
      caveat:
        "Ordinary-workout best powers are a lower bound on capacity, not evidence of a maximal test.",
    },
    environment: {
      averageTemperatureC: mean(temperature.values),
      valueKind: "calculated_from_samples" as const,
    },
    provenance: {
      sourceProviders: [...new Set(context.sourceProviders)].sort(),
      sourceDevices: [...new Set(context.sourceDevices)].sort(),
      powerMeasurementKinds: [...new Set(context.powerMeasurementKinds)].sort(),
      sensorBoundary: "analytics.activity_sensor_sample FINAL" as const,
      sourceConflicts: "upstream_conflicts_not_exposed_by_deduplicated_model" as const,
    },
    streamQuality,
    quality: { status: reasons.length === 0 ? ("high" as const) : ("limited" as const), reasons },
    unavailableReasons,
  };
}

export type CyclingEffortMetrics = ReturnType<typeof calculateCyclingEffortMetrics>;

export interface CyclingEffortRequest extends CyclingEffortActivity {
  activityDate: string;
  durationSeconds: number;
  sourceProviders: string[];
  movingDuration: ReturnType<typeof buildMovingDuration>;
}

const movementSampleSchema = z.object({
  activity_id: z.string().uuid(),
  elapsed_seconds: z.coerce.number(),
  channel: z.enum(["speed", "altitude", "temperature"]),
  scalar: z.coerce.number().nullable(),
  provider_id: z.string().nullable(),
  device_id: z.string().nullable(),
  measurement_kind: z.enum(["direct", "estimated", "unknown"]),
});

const distanceSchema = z.object({
  activity_id: z.string().uuid(),
  distance_meters: z.coerce.number().nullable(),
});

/** Bounded canonical IDs already authorized by the calling repository. */
export async function loadCyclingEffortMetrics(
  db: Pick<Database, "execute">,
  store: Pick<ActivitySensorStore, "query">,
  userId: string,
  timezone: string,
  activities: CyclingEffortRequest[],
  durationsSeconds: number[],
) {
  if (activities.length > 25) throw new Error("At most 25 cycling activities may be calculated");
  if (activities.length === 0) return [];
  const activityIds = activities.map((activity) => activity.activity_id);
  const dates = activities.map((activity) => activity.activityDate).sort();
  const firstDate = dates[0];
  const lastDate = dates.at(-1);
  if (!firstDate || !lastDate) throw new Error("Cycling activities require local dates");
  const [data, movementSamples, distances, weights] = await Promise.all([
    loadCyclingEffortData(db, store, userId, activities, durationsSeconds),
    store.query(
      movementSampleSchema,
      `/* cycling-effort:movement-samples */
      SELECT toString(sensor.activity_id) AS activity_id,
        dateDiff('millisecond', activity.started_at, sensor.recorded_at) / 1000 AS elapsed_seconds,
        sensor.channel, sensor.scalar, sensor.provider_id, sensor.device_id, sensor.measurement_kind
      FROM analytics.activity_sensor_sample AS sensor FINAL
      INNER JOIN analytics.deduped_activities AS activity FINAL
        ON activity.activity_id = sensor.activity_id AND activity.user_id = sensor.user_id
      WHERE sensor.user_id = {userId:UUID}
        AND sensor.activity_id IN ({activityIds:Array(UUID)})
        AND sensor.channel IN ('speed', 'altitude', 'temperature')
        AND sensor.is_deleted = 0 AND activity.is_deleted = 0
      ORDER BY sensor.activity_id, sensor.recorded_at`,
      { userId, activityIds },
    ),
    store.query(
      distanceSchema,
      `/* cycling-effort:distance */
      SELECT toString(activity_id) AS activity_id, total_distance AS distance_meters
      FROM analytics.activity_summary_rows FINAL
      WHERE user_id = {userId:UUID} AND activity_id IN ({activityIds:Array(UUID)})
        AND is_deleted = 0`,
      { userId, activityIds },
    ),
    loadDirectWeightObservations(store, userId, timezone, firstDate, lastDate),
  ]);
  return activities.map((activity) => {
    const coreSamples = data.sampleRows.filter((row) => row.activity_id === activity.activity_id);
    const extraSamples = movementSamples.filter((row) => row.activity_id === activity.activity_id);
    const samples: CyclingEffortSample[] = coreSamples.map((row) => ({
      elapsedSeconds: row.elapsed_seconds,
      powerWatts: row.power,
      heartRateBpm: row.heart_rate,
      cadenceRpm: row.cadence,
    }));
    const fields = {
      speed: "speedMetersPerSecond",
      altitude: "altitudeMeters",
      temperature: "temperatureC",
    } as const;
    samples.push(
      ...extraSamples.map((row) => ({
        elapsedSeconds: row.elapsed_seconds,
        [fields[row.channel]]: row.scalar,
      })),
    );
    const intervals = recordedIntervalsForActivity(activity, data.intervalRows);
    const distance = distances.find(
      (row) => row.activity_id === activity.activity_id,
    )?.distance_meters;
    return {
      activityId: activity.activity_id,
      memberActivityIds: activity.member_activity_ids,
      activityDate: activity.activityDate,
      metrics: calculateCyclingEffortMetrics(samples, {
        durationSeconds: activity.durationSeconds,
        activityDate: activity.activityDate,
        settingsHistory: data.settingsHistory,
        intervals: intervals.map((item) => item.input),
        intervalEvidence: intervals,
        weightObservations: weights,
        sourceProviders: [
          ...activity.sourceProviders,
          ...coreSamples.flatMap((row) => row.source_providers),
          ...extraSamples.flatMap((row) => (row.provider_id ? [row.provider_id] : [])),
        ],
        sourceDevices: [
          ...coreSamples.flatMap((row) => row.source_devices),
          ...extraSamples.flatMap((row) => (row.device_id ? [row.device_id] : [])),
        ],
        powerMeasurementKinds: coreSamples.flatMap((row) => row.power_measurement_kinds),
        movingDuration: activity.movingDuration,
        ...(distance == null
          ? {}
          : { distanceEvidence: { meters: distance, kind: "deduplicated_summary" } }),
        bestPowers: data.bestPowerRows.filter((row) => row.activity_id === activity.activity_id),
      }),
    };
  });
}

export interface CyclingEffortActivity {
  activity_id: string;
  member_activity_ids: string[];
  started_at: string;
}

const sampleRowSchema = z.object({
  activity_id: z.string().uuid(),
  elapsed_seconds: z.coerce.number().nonnegative(),
  power: z.coerce.number().nullable(),
  heart_rate: z.coerce.number().nullable(),
  cadence: z.coerce.number().nullable(),
  source_providers: z.array(z.string()),
  source_devices: z.array(z.string()),
  power_measurement_kinds: z.array(z.enum(["direct", "estimated", "unknown"])),
});

const bestPowerRowSchema = z.object({
  activity_id: z.string().uuid(),
  duration_seconds: z.coerce.number().int().positive(),
  best_power: z.coerce.number().nonnegative(),
  start_offset_seconds: z.coerce.number().nonnegative().nullable(),
  observed_samples: z.coerce.number().int().nonnegative().nullable(),
  coverage_pct: z.coerce.number().min(0).max(100).nullable(),
  largest_gap_seconds: z.coerce.number().nonnegative().nullable(),
  median_sample_interval_seconds: z.coerce.number().positive().nullable(),
  power_measurement_kind: z.enum(["direct", "estimated", "unknown"]).nullable(),
});

const intervalRowSchema = z.object({
  member_activity_id: z.string().uuid(),
  interval_index: z.coerce.number().int(),
  label: z.string().nullable(),
  interval_type: z.string().nullable(),
  started_at: timestampStringSchema,
  ended_at: timestampStringSchema.nullable(),
  source_kind: z.enum(["provider_recorded", "inferred"]).nullable(),
  source_provider: z.string().nullable(),
  source_activity_id: z.string().uuid().nullable(),
  segment_type: z.string().nullable(),
  target_intensity: z.coerce.number().nullable(),
  target_zone: z.coerce.number().int().nullable(),
  target_cadence_rpm: z.coerce.number().nullable(),
  target_power_watts: z.coerce.number().nullable(),
  target_resistance: z.coerce.number().nullable(),
  work_recovery_kind: z.enum(["work", "recovery"]).nullable(),
  raw: z.unknown().nullable(),
});

const zonePctsSchema = z
  .array(z.number().positive())
  .min(1)
  .refine((values) =>
    values.every((value, index) => index === 0 || value > (values[index - 1] ?? 0)),
  );

export interface RecordedIntervalEvidence {
  input: CyclingWorkoutIntervalInput;
  interval: ComparableInterval;
  memberActivityIds: string[];
}

function parseZonePcts(value: unknown): number[] | null {
  const parsed = zonePctsSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function effectiveSettings(
  history: SportSettingsRow[],
  activityDate: string,
): SportSettingsRow | null {
  return (
    history
      .filter((row) => row.effectiveFrom <= activityDate)
      .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0] ?? null
  );
}

function workoutSettings(row: SportSettingsRow | null): CyclingWorkoutSettings | null {
  if (!row) return null;
  return {
    ftpWatts: row.ftp,
    thresholdHeartRateBpm: row.thresholdHr,
    powerZoneUpperPcts: parseZonePcts(row.powerZonePcts),
    heartRateZoneUpperPcts: parseZonePcts(row.hrZonePcts),
  };
}

function normalizeIntervalType(value: string | null): CyclingWorkoutIntervalInput["type"] {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "work" || normalized === "recovery") return normalized;
  if (normalized === "warmup" || normalized === "warm_up") return "warmup";
  if (normalized === "cooldown" || normalized === "cool_down") return "cooldown";
  return "other";
}

export function recordedIntervalsForActivity(
  activity: CyclingEffortActivity,
  rows: z.infer<typeof intervalRowSchema>[],
): RecordedIntervalEvidence[] {
  const members = new Set(activity.member_activity_ids);
  const startedAt = Date.parse(activity.started_at);
  const comparable = rows.flatMap((row): ComparableInterval[] => {
    if (!members.has(row.member_activity_id) || row.ended_at == null) return [];
    const startOffsetSeconds = Math.round((Date.parse(row.started_at) - startedAt) / 1_000);
    const endOffsetSeconds = Math.round((Date.parse(row.ended_at) - startedAt) / 1_000);
    if (endOffsetSeconds <= startOffsetSeconds) return [];
    const interval: ComparableInterval = {
      intervalIndex: row.interval_index,
      source: row.source_kind ?? "unknown",
      startOffsetSeconds,
      endOffsetSeconds,
      label: row.label,
      intervalType: row.interval_type,
      segmentType: row.segment_type,
      workRecoveryKind: row.work_recovery_kind,
      sourceProvider: row.source_provider,
      sourceActivityId: row.source_activity_id,
      sourceMemberActivityIds: [row.member_activity_id],
      targetIntensity: row.target_intensity,
      targetZone: row.target_zone,
      targetCadenceRpm: row.target_cadence_rpm,
      targetPowerWatts: row.target_power_watts,
      targetResistance: row.target_resistance,
      raw: row.raw,
    };
    return [interval.source === "inferred" ? inferIntervalResult(interval) : interval];
  });

  return mergeComparableIntervals(comparable).map((interval) => ({
    input: {
      index: interval.intervalIndex,
      type: normalizeIntervalType(
        interval.workRecoveryKind ?? interval.segmentType ?? interval.intervalType ?? null,
      ),
      label: interval.label,
      startOffsetSeconds: interval.startOffsetSeconds,
      endOffsetSeconds: interval.endOffsetSeconds,
      targetPowerWatts: interval.targetPowerWatts,
    },
    interval,
    memberActivityIds: interval.sourceMemberActivityIds,
  }));
}

export async function loadCyclingEffortData(
  db: Pick<Database, "execute">,
  store: Pick<ActivitySensorStore, "query">,
  userId: string,
  pageRows: CyclingEffortActivity[],
  durationsSeconds: number[],
) {
  const activityIds = pageRows.map((row) => row.activity_id);
  const memberActivityIds = [...new Set(pageRows.flatMap((row) => row.member_activity_ids))];
  const memberActivityIdList = sql.join(
    memberActivityIds.map((memberActivityId) => sql`${memberActivityId}::uuid`),
    sql`, `,
  );

  const [sampleRows, bestPowerRows, settingsHistory, intervalRows] = await Promise.all([
    activityIds.length === 0
      ? []
      : store.query(
          sampleRowSchema,
          `/* cycling-training-metrics:samples */
            SELECT
              toString(sensor.activity_id) AS activity_id,
              dateDiff('millisecond', activity.started_at, sensor.recorded_at) / 1000 AS elapsed_seconds,
              if(countIf(sensor.channel = 'power') = 0, NULL,
                maxIf(sensor.scalar, sensor.channel = 'power')) AS power,
              if(countIf(sensor.channel = 'heart_rate') = 0, NULL,
                maxIf(sensor.scalar, sensor.channel = 'heart_rate')) AS heart_rate,
              if(countIf(sensor.channel = 'cadence') = 0, NULL,
                maxIf(sensor.scalar, sensor.channel = 'cadence')) AS cadence,
              arraySort(groupUniqArrayIf(sensor.provider_id, sensor.provider_id != '')) AS source_providers,
              arraySort(groupUniqArrayIf(sensor.device_id, sensor.device_id != '')) AS source_devices,
              arraySort(groupUniqArrayIf(sensor.measurement_kind,
                sensor.channel = 'power' AND sensor.measurement_kind != '')) AS power_measurement_kinds
            FROM analytics.activity_sensor_sample AS sensor FINAL
            INNER JOIN analytics.deduped_activities AS activity FINAL
              ON activity.activity_id = sensor.activity_id AND activity.user_id = sensor.user_id
            WHERE sensor.user_id = {userId:UUID}
              AND sensor.activity_id IN ({activityIds:Array(UUID)})
              AND sensor.channel IN ('power', 'heart_rate', 'cadence')
              AND sensor.is_deleted = 0
            GROUP BY sensor.activity_id, activity.started_at, sensor.recorded_at
            ORDER BY sensor.activity_id, sensor.recorded_at`,
          { userId: userId, activityIds },
        ),
    activityIds.length === 0 || durationsSeconds.length === 0
      ? []
      : store.query(
          bestPowerRowSchema,
          `/* cycling-training-metrics:power-curve */
            SELECT
              toString(curve.activity_id) AS activity_id,
              curve.duration_seconds AS duration_seconds,
              curve.best_power AS best_power,
              curve.start_offset_seconds AS start_offset_seconds,
              curve.observed_samples AS observed_samples,
              curve.coverage_pct AS coverage_pct,
              curve.largest_gap_seconds AS largest_gap_seconds,
              curve.median_sample_interval_seconds AS median_sample_interval_seconds,
              curve.power_measurement_kind AS power_measurement_kind
            FROM analytics.activity_power_curve AS curve FINAL
            WHERE curve.user_id = {userId:UUID}
              AND curve.activity_id IN ({activityIds:Array(UUID)})
              AND curve.duration_seconds IN ({durations:Array(UInt32)})
              AND curve.is_deleted = 0
            ORDER BY curve.activity_id, curve.duration_seconds`,
          { userId: userId, activityIds, durations: durationsSeconds },
        ),
    new SportSettingsRepository(db, userId).history("cycling"),
    memberActivityIds.length === 0
      ? []
      : executeWithSchema(
          db,
          intervalRowSchema,
          sql`
              SELECT
                activity_id::text AS member_activity_id,
                interval_index,
                label,
                interval_type,
                started_at,
                ended_at,
                source_kind,
                source_provider,
                source_activity_id,
                segment_type,
                target_intensity,
                target_zone,
                target_cadence_rpm,
                target_power_watts,
                target_resistance,
                work_recovery_kind,
                raw
              FROM fitness.activity_interval
              WHERE activity_id IN (${memberActivityIdList})
              ORDER BY activity_id, interval_index
            `,
        ),
  ]);

  return { sampleRows, bestPowerRows, settingsHistory, intervalRows };
}
