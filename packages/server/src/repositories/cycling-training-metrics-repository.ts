import { createHash } from "node:crypto";
import type {
  CyclingWorkoutMetrics,
  CyclingWorkoutSample,
} from "@dofek/training/cycling-workout-metrics";
import type { Database } from "dofek/db";
import { z } from "zod";
import type { ActivitySensorStore } from "./activity-repository.ts";
import {
  calculateCyclingEffortMetrics,
  effectiveSettings,
  loadCyclingEffortData,
  type RecordedIntervalEvidence,
  recordedIntervalsForActivity,
} from "./cycling-effort-metrics.ts";
import type { SportSettingsRow } from "./sport-settings-repository.ts";

const activityRowSchema = z.object({
  activity_id: z.string().uuid(),
  activity_date: z.string(),
  started_at: z.string(),
  ended_at: z.string().nullable(),
  elapsed_seconds: z.coerce.number().int().nonnegative(),
  modality: z.string().nullable(),
  activity_name: z.string().nullable(),
  provider_id: z.string(),
  source_providers: z.array(z.string()),
  member_activity_ids: z.array(z.string().uuid()),
  activity_timezone: z.string().nullable(),
  local_time_source: z.string(),
  aggregate_average_power: z.coerce.number().nullable(),
  aggregate_normalized_power: z.coerce.number().nullable(),
  aggregate_average_heart_rate: z.coerce.number().nullable(),
  aggregate_max_heart_rate: z.coerce.number().nullable(),
});

type ActivityRow = z.infer<typeof activityRowSchema>;

const cursorSchema = z.object({
  version: z.literal(1),
  userId: z.string().uuid(),
  shape: z.string(),
  startedAt: z.string(),
  activityId: z.string().uuid(),
});

type Cursor = z.infer<typeof cursorSchema>;

export interface CyclingTrainingMetricsInput {
  startDate: string;
  endDate: string;
  modalities: string[];
  providers: string[];
  durationsSeconds: number[];
  cursor: string | null;
  limit: number;
}

function cursorShape(input: CyclingTrainingMetricsInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        startDate: input.startDate,
        endDate: input.endDate,
        modalities: input.modalities,
        providers: input.providers,
        durationsSeconds: input.durationsSeconds,
      }),
    )
    .digest("base64url")
    .slice(0, 22);
}

function decodeCursor(value: string | null, userId: string, shape: string): Cursor | null {
  if (!value) return null;
  try {
    const cursor = cursorSchema.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
    if (cursor.userId !== userId || cursor.shape !== shape) throw new Error("Cursor mismatch");
    return cursor;
  } catch {
    throw new Error("Invalid cycling training-metrics cursor");
  }
}

function encodeCursor(row: ActivityRow, userId: string, shape: string): string {
  return Buffer.from(
    JSON.stringify({
      version: 1,
      userId,
      shape,
      startedAt: row.started_at,
      activityId: row.activity_id,
    } satisfies Cursor),
    "utf8",
  ).toString("base64url");
}

function snakeCoverage(coverage: CyclingWorkoutMetrics["coverage"]["power"]) {
  return {
    observed_samples: coverage.observedSamples,
    covered_seconds: coverage.coveredSeconds,
    missing_seconds: coverage.missingSeconds,
    zero_seconds: coverage.zeroSeconds,
    coverage_pct: coverage.coveragePct,
    median_sample_interval_seconds: coverage.medianSampleIntervalSeconds,
    largest_gap_seconds: coverage.largestGapSeconds,
  };
}

function snakeZones(zones: CyclingWorkoutMetrics["powerZones"]) {
  if (!zones) return null;
  return {
    threshold: zones.threshold,
    upper_pcts: zones.upperPcts,
    zones: zones.zones,
  };
}

function snakeMetrics(
  metrics: CyclingWorkoutMetrics,
  recordedIntervals: RecordedIntervalEvidence[],
) {
  return {
    value_kind: "calculated_from_samples" as const,
    power: {
      average_watts: metrics.power.averageWatts,
      normalized_watts: metrics.power.normalizedWatts,
      variability_index: metrics.power.variabilityIndex,
      work_kilojoules: metrics.power.workKilojoules,
      intensity_factor: metrics.power.intensityFactor,
      training_stress_score: metrics.power.trainingStressScore,
    },
    heart_rate: {
      average_bpm: metrics.heartRate.averageBpm,
      maximum_bpm: metrics.heartRate.maximumBpm,
    },
    cadence: { average_rpm: metrics.cadence.averageRpm },
    aerobic_efficiency: {
      power_to_heart_rate_ratio: metrics.aerobicEfficiency.powerToHeartRateRatio,
      paired_seconds: metrics.aerobicEfficiency.pairedSeconds,
    },
    cardiac_drift: {
      percent: metrics.cardiacDrift.percent,
      first_half_power_to_heart_rate: metrics.cardiacDrift.firstHalfPowerToHeartRate,
      second_half_power_to_heart_rate: metrics.cardiacDrift.secondHalfPowerToHeartRate,
      paired_seconds: metrics.cardiacDrift.pairedSeconds,
      method: metrics.cardiacDrift.method,
    },
    power_zones: snakeZones(metrics.powerZones),
    heart_rate_zones: snakeZones(metrics.heartRateZones),
    coverage: {
      power: snakeCoverage(metrics.coverage.power),
      heart_rate: snakeCoverage(metrics.coverage.heartRate),
      cadence: snakeCoverage(metrics.coverage.cadence),
    },
    interval_source: metrics.intervalSource,
    interval_detection:
      metrics.intervalDetection == null
        ? null
        : {
            method: metrics.intervalDetection.method,
            threshold_watts: metrics.intervalDetection.thresholdWatts,
            minimum_work_seconds: metrics.intervalDetection.minimumWorkSeconds,
          },
    intervals: metrics.intervals.map((interval) => {
      const evidence = recordedIntervals.find(
        (candidate) =>
          candidate.input.startOffsetSeconds === interval.startOffsetSeconds &&
          candidate.input.endOffsetSeconds === interval.endOffsetSeconds,
      );
      const sourceKind = evidence?.interval.source ?? "inferred";
      const inferred = sourceKind === "inferred";
      return {
        index: interval.index,
        type: interval.type,
        label: interval.label,
        source: interval.source,
        start_offset_seconds: interval.startOffsetSeconds,
        end_offset_seconds: interval.endOffsetSeconds,
        duration_seconds: interval.durationSeconds,
        average_power_watts: interval.averagePowerWatts,
        normalized_power_watts: interval.normalizedPowerWatts,
        average_heart_rate_bpm: interval.averageHeartRateBpm,
        average_cadence_rpm: interval.averageCadenceRpm,
        source_kind: sourceKind,
        source_provider: evidence?.interval.sourceProvider ?? null,
        source_activity_id: evidence?.interval.sourceActivityId ?? null,
        segment_type: evidence?.interval.segmentType ?? null,
        target_intensity: inferred ? null : (evidence?.interval.targetIntensity ?? null),
        target_zone: inferred ? null : (evidence?.interval.targetZone ?? null),
        target_cadence_rpm: inferred ? null : (evidence?.interval.targetCadenceRpm ?? null),
        target_power_watts: inferred ? null : interval.targetPowerWatts,
        target_resistance: inferred ? null : (evidence?.interval.targetResistance ?? null),
        work_recovery_kind: evidence?.interval.workRecoveryKind ?? null,
        completion_pct: inferred ? null : interval.completionPct,
        source_member_activity_ids: evidence?.memberActivityIds ?? [],
        raw: evidence?.interval.raw ?? null,
      };
    }),
    unavailable_reasons: metrics.unavailableReasons.map(({ metric, reason }) => ({
      metric,
      reason,
    })),
  };
}

function thresholdEvidence(settings: SportSettingsRow | null) {
  if (!settings) return { ftp: null, threshold_heart_rate: null };
  return {
    ftp:
      settings.ftp != null && settings.ftp > 0
        ? {
            value: settings.ftp,
            unit: "W",
            effective_from: settings.effectiveFrom,
            source_record_id: settings.id,
            kind: "configured" as const,
          }
        : null,
    threshold_heart_rate:
      settings.thresholdHr != null && settings.thresholdHr > 0
        ? {
            value: settings.thresholdHr,
            unit: "bpm",
            effective_from: settings.effectiveFrom,
            source_record_id: settings.id,
            kind: "configured" as const,
          }
        : null,
  };
}

function bestPowerQuality(row: z.infer<typeof bestPowerRowSchema>) {
  const reasons: string[] = [];
  if (row.coverage_pct == null || row.coverage_pct < 99)
    reasons.push("Power-window coverage is incomplete");
  if (row.power_measurement_kind !== "direct")
    reasons.push("Power was not uniformly directly measured");
  return {
    status: reasons.length === 0 ? ("high" as const) : ("limited" as const),
    reasons,
    observed_samples: row.observed_samples,
    coverage_pct: row.coverage_pct,
    median_sample_interval_seconds: row.median_sample_interval_seconds,
    largest_gap_seconds: row.largest_gap_seconds,
  };
}

function definitions() {
  return {
    normalized_power:
      "Fourth root of the mean fourth power of complete 30-second rolling average power.",
    variability_index: "Normalized power divided by average power.",
    intensity_factor: "Normalized power divided by FTP effective on the activity date.",
    training_stress_score: "Elapsed hours multiplied by intensity factor squared and 100.",
    work_kilojoules: "Sum of covered one-second power values divided by 1,000.",
    aerobic_efficiency: "Mean synchronized power divided by mean synchronized heart rate.",
    cardiac_drift:
      "100 × (first-half power:HR - second-half power:HR) / first-half power:HR, using equal elapsed halves.",
    interval_detection:
      "Recorded boundaries take precedence; otherwise work requires a 30-second mean at or above 105% of effective FTP.",
  };
}

/** Canonical, deduplicated, per-activity cycling calculations for MCP analysis. */
export class CyclingTrainingMetricsRepository {
  readonly #db: Pick<Database, "execute">;
  readonly #store: Pick<ActivitySensorStore, "query">;
  readonly #userId: string;
  readonly #timezone: string;

  constructor(
    db: Pick<Database, "execute">,
    store: Pick<ActivitySensorStore, "query">,
    userId: string,
    timezone: string,
  ) {
    this.#db = db;
    this.#store = store;
    this.#userId = userId;
    this.#timezone = timezone;
  }

  async listRange(input: CyclingTrainingMetricsInput) {
    const shape = cursorShape(input);
    const cursor = decodeCursor(input.cursor, this.#userId, shape);
    const cursorFilter = cursor
      ? `AND (
        cycling.started_at < parseDateTime64BestEffort({cursorStartedAt:String}, 6)
        OR (
          cycling.started_at = parseDateTime64BestEffort({cursorStartedAt:String}, 6)
          AND cycling.activity_id > {cursorActivityId:UUID}
        )
      )`
      : "";
    const params = {
      userId: this.#userId,
      timezone: this.#timezone,
      startDate: input.startDate,
      endDate: input.endDate,
      modalities: input.modalities,
      providers: input.providers,
      pageLimit: input.limit + 1,
      ...(cursor ? { cursorStartedAt: cursor.startedAt, cursorActivityId: cursor.activityId } : {}),
    };
    const activityRows = await this.#store.query(
      activityRowSchema,
      `/* cycling-training-metrics:activities */
      SELECT
        toString(cycling.activity_id) AS activity_id,
        toString(toDate(toTimeZone(cycling.started_at, {timezone:String}))) AS activity_date,
        formatDateTime(cycling.started_at, '%Y-%m-%dT%H:%i:%S.%fZ', 'UTC') AS started_at,
        if(cycling.ended_at IS NULL, NULL,
          formatDateTime(cycling.ended_at, '%Y-%m-%dT%H:%i:%S.%fZ', 'UTC')) AS ended_at,
        cycling.elapsed_seconds AS elapsed_seconds,
        cycling.modality AS modality,
        cycling.activity_name AS activity_name,
        cycling.provider_id AS provider_id,
        activity.source_providers AS source_providers,
        activity.member_activity_ids AS member_activity_ids,
        activity.timezone AS activity_timezone,
        activity.local_time_source AS local_time_source,
        cycling.average_power AS aggregate_average_power,
        cycling.normalized_power AS aggregate_normalized_power,
        cycling.average_heart_rate AS aggregate_average_heart_rate,
        cycling.max_heart_rate AS aggregate_max_heart_rate
      FROM analytics.cycling_activity AS cycling FINAL
      INNER JOIN analytics.deduped_activities AS activity FINAL
        ON activity.activity_id = cycling.activity_id
        AND activity.user_id = cycling.user_id
      WHERE cycling.user_id = {userId:UUID}
        AND cycling.is_deleted = 0
        AND activity.is_deleted = 0
        AND toDate(toTimeZone(cycling.started_at, {timezone:String}))
          BETWEEN toDate({startDate:String}) AND toDate({endDate:String})
        AND (empty({modalities:Array(String)}) OR has({modalities:Array(String)}, cycling.modality))
        AND (empty({providers:Array(String)}) OR hasAny(activity.source_providers, {providers:Array(String)}))
        ${cursorFilter}
      ORDER BY cycling.started_at DESC, cycling.activity_id ASC
      LIMIT {pageLimit:UInt32}`,
      params,
    );
    const pageRows = activityRows.slice(0, input.limit);
    const hasMore = activityRows.length > input.limit;
    const { sampleRows, bestPowerRows, settingsHistory, intervalRows } =
      await loadCyclingEffortData(
        this.#db,
        this.#store,
        this.#userId,
        pageRows,
        input.durationsSeconds,
      );

    const activities = pageRows.map((activity) => {
      const activitySamples = sampleRows.filter((row) => row.activity_id === activity.activity_id);
      const samples: CyclingWorkoutSample[] = activitySamples.map((row) => ({
        elapsedSeconds: row.elapsed_seconds,
        powerWatts: row.power,
        heartRateBpm: row.heart_rate,
        cadenceRpm: row.cadence,
      }));
      const settings = effectiveSettings(settingsHistory, activity.activity_date);
      const recordedIntervals = recordedIntervalsForActivity(activity, intervalRows);
      const { workout: metrics } = calculateCyclingEffortMetrics(samples, {
        durationSeconds: activity.elapsed_seconds,
        activityDate: activity.activity_date,
        settingsHistory,
        intervals: recordedIntervals.map((interval) => interval.input),
        weightObservations: [],
        powerMeasurementKinds: activitySamples.flatMap((row) => row.power_measurement_kinds),
        sourceProviders: activity.source_providers,
        sourceDevices: activitySamples.flatMap((row) => row.source_devices),
      });
      const sourceDevices = [
        ...new Set(activitySamples.flatMap((row) => row.source_devices)),
      ].sort();
      const sampleProviders = [
        ...new Set(activitySamples.flatMap((row) => row.source_providers)),
      ].sort();
      const powerKinds = [
        ...new Set(activitySamples.flatMap((row) => row.power_measurement_kinds)),
      ].sort();
      const qualityReasons: string[] = [];
      if (metrics.coverage.power.coveragePct < 99)
        qualityReasons.push("Power coverage is incomplete");
      if (powerKinds.includes("estimated")) qualityReasons.push("Some power samples are estimated");
      if (powerKinds.length === 0 || powerKinds.includes("unknown")) {
        qualityReasons.push("Power measurement provenance is incomplete");
      }
      const timezoneAssumptionRequired =
        activity.activity_timezone == null || activity.local_time_source === "unknown";
      if (timezoneAssumptionRequired) {
        qualityReasons.push(
          `User timezone ${this.#timezone} was required for local-date alignment`,
        );
      }
      return {
        activity_id: activity.activity_id,
        date: activity.activity_date,
        started_at: activity.started_at,
        ended_at: activity.ended_at,
        duration_seconds: activity.elapsed_seconds,
        name: activity.activity_name,
        modality: activity.modality,
        provider_id: activity.provider_id,
        source_providers: activity.source_providers,
        source_devices: sourceDevices,
        member_activity_ids: activity.member_activity_ids,
        thresholds: thresholdEvidence(settings),
        metrics: snakeMetrics(metrics, recordedIntervals),
        best_powers: bestPowerRows
          .filter((row) => row.activity_id === activity.activity_id)
          .map((row) => ({
            duration_seconds: row.duration_seconds,
            watts: row.best_power,
            start_offset_seconds: row.start_offset_seconds,
            power_kind: row.power_measurement_kind ?? "unknown",
            quality: bestPowerQuality(row),
          })),
        provider_aggregates: {
          average_power_watts: activity.aggregate_average_power,
          normalized_power_watts: activity.aggregate_normalized_power,
          average_heart_rate_bpm: activity.aggregate_average_heart_rate,
          maximum_heart_rate_bpm: activity.aggregate_max_heart_rate,
          kind: "calculated_read_model" as const,
        },
        provenance: {
          duplicate_merged: activity.member_activity_ids.length > 1,
          sample_source_providers: sampleProviders,
          power_measurement_kinds: powerKinds,
          activity_timezone: activity.activity_timezone,
          timezone_source: activity.local_time_source,
          timezone_assumption_required: timezoneAssumptionRequired,
        },
        quality: {
          status:
            qualityReasons.length === 0 && powerKinds.every((kind) => kind === "direct")
              ? ("high" as const)
              : qualityReasons.length <= 1
                ? ("moderate" as const)
                : ("limited" as const),
          trustworthy_for_longitudinal_comparison: qualityReasons.length === 0,
          reasons: qualityReasons,
        },
      };
    });

    const last = pageRows.at(-1);
    return {
      range: { start_date: input.startDate, end_date: input.endDate, timezone: this.#timezone },
      requested_best_power_durations_seconds: input.durationsSeconds,
      definitions: definitions(),
      activities,
      next_cursor: hasMore && last ? encodeCursor(last, this.#userId, shape) : null,
    };
  }
}
