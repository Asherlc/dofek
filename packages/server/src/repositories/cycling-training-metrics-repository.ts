import { createHash } from "node:crypto";
import {
  type CyclingWorkoutIntervalInput,
  type CyclingWorkoutMetrics,
  type CyclingWorkoutSample,
  type CyclingWorkoutSettings,
  computeCyclingWorkoutMetrics,
} from "@dofek/training/cycling-workout-metrics";
import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema, timestampStringSchema } from "../lib/typed-sql.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";
import { SportSettingsRepository, type SportSettingsRow } from "./sport-settings-repository.ts";

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

const sampleRowSchema = z.object({
  activity_id: z.string().uuid(),
  elapsed_seconds: z.coerce.number().nonnegative(),
  power: z.coerce.number().nonnegative().nullable(),
  heart_rate: z.coerce.number().nonnegative().nullable(),
  cadence: z.coerce.number().nonnegative().nullable(),
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
});

const cursorSchema = z.object({
  version: z.literal(1),
  userId: z.string().uuid(),
  shape: z.string(),
  startedAt: z.string(),
  activityId: z.string().uuid(),
});

type Cursor = z.infer<typeof cursorSchema>;

const zonePctsSchema = z
  .array(z.number().positive())
  .min(1)
  .refine((values) =>
    values.every((value, index) => index === 0 || value > (values[index - 1] ?? 0)),
  );

export interface CyclingTrainingMetricsInput {
  startDate: string;
  endDate: string;
  modalities: string[];
  providers: string[];
  durationsSeconds: number[];
  cursor: string | null;
  limit: number;
}

interface RecordedIntervalEvidence {
  input: CyclingWorkoutIntervalInput;
  memberActivityIds: string[];
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

function parseZonePcts(value: unknown): number[] | null {
  const parsed = zonePctsSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function effectiveSettings(
  history: SportSettingsRow[],
  activityDate: string,
): SportSettingsRow | null {
  return history.find((row) => row.effectiveFrom <= activityDate) ?? null;
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

function recordedIntervalsForActivity(
  activity: ActivityRow,
  rows: z.infer<typeof intervalRowSchema>[],
): RecordedIntervalEvidence[] {
  const members = new Set(activity.member_activity_ids);
  const startedAt = Date.parse(activity.started_at);
  const grouped = new Map<string, RecordedIntervalEvidence>();
  for (const row of rows) {
    if (!members.has(row.member_activity_id) || row.ended_at == null) continue;
    const startOffsetSeconds = Math.round((Date.parse(row.started_at) - startedAt) / 1_000);
    const endOffsetSeconds = Math.round((Date.parse(row.ended_at) - startedAt) / 1_000);
    if (endOffsetSeconds <= startOffsetSeconds) continue;
    const type = normalizeIntervalType(row.interval_type);
    const key = `${startOffsetSeconds}:${endOffsetSeconds}:${type}:${row.label ?? ""}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.memberActivityIds.push(row.member_activity_id);
      existing.memberActivityIds.sort();
      continue;
    }
    grouped.set(key, {
      input: {
        index: row.interval_index,
        type,
        label: row.label,
        startOffsetSeconds,
        endOffsetSeconds,
        targetPowerWatts: null,
      },
      memberActivityIds: [row.member_activity_id],
    });
  }
  return [...grouped.values()].sort(
    (left, right) =>
      left.input.startOffsetSeconds - right.input.startOffsetSeconds ||
      left.input.index - right.input.index,
  );
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
          candidate.input.endOffsetSeconds === interval.endOffsetSeconds &&
          candidate.input.type === interval.type,
      );
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
        target_power_watts: interval.targetPowerWatts,
        completion_pct: interval.completionPct,
        source_member_activity_ids: evidence?.memberActivityIds ?? [],
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
    const activityIds = pageRows.map((row) => row.activity_id);
    const memberActivityIds = [...new Set(pageRows.flatMap((row) => row.member_activity_ids))];
    const memberActivityIdList = sql.join(
      memberActivityIds.map((memberActivityId) => sql`${memberActivityId}::uuid`),
      sql`, `,
    );

    const [sampleRows, bestPowerRows, settingsHistory, intervalRows] = await Promise.all([
      activityIds.length === 0
        ? []
        : this.#store.query(
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
            { userId: this.#userId, activityIds },
          ),
      activityIds.length === 0 || input.durationsSeconds.length === 0
        ? []
        : this.#store.query(
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
            { userId: this.#userId, activityIds, durations: input.durationsSeconds },
          ),
      new SportSettingsRepository(this.#db, this.#userId).history("cycling"),
      memberActivityIds.length === 0
        ? []
        : executeWithSchema(
            this.#db,
            intervalRowSchema,
            sql`
              SELECT
                activity_id::text AS member_activity_id,
                interval_index,
                label,
                interval_type,
                started_at,
                ended_at
              FROM fitness.activity_interval
              WHERE activity_id IN (${memberActivityIdList})
              ORDER BY activity_id, interval_index
            `,
          ),
    ]);

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
      const metrics = computeCyclingWorkoutMetrics({
        durationSeconds: activity.elapsed_seconds,
        samples,
        settings: workoutSettings(settings),
        intervals: recordedIntervals.map((interval) => interval.input),
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
