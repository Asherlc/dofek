import {
  offsetMinutesFromTimestamp,
  resolveRecordLocalTimeContext,
} from "@dofek/format/record-local-time";
import { selectDailyHeartRateVariability } from "@dofek/heart-rate-variability";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { Database, SyncDatabase } from "../../../../src/db/index.ts";
import { getProviderDataGenerations } from "../../../../src/db/provider-data-deletion.ts";
import {
  BODY_MEASUREMENT_COLUMN_TO_CHANNEL,
  SOURCE_TYPE_API,
} from "../../../../src/db/sensor-channels.ts";
import type { MetricStreamRowInput } from "../../../../src/metric-stream/events.ts";
import {
  getDefaultMetricStreamEventPublisher,
  type MetricStreamEventPublisher,
} from "../../../../src/metric-stream/redpanda-producer.ts";
import { writeMetricStreamRows } from "../../../../src/metric-stream/write-metric-stream.ts";
import { computeBoundsFromIsoTimestamps } from "../lib/health-kit-sync-helpers.ts";
import { executeWithSchema } from "../lib/typed-sql.ts";
import { processWorkouts as processWorkoutsShared } from "../routers/health-kit-sync-processors.ts";
import {
  type AdditiveDailyMetricAccumulatorKey,
  additiveDailyMetricTypes,
  type DailyMetricAccumulator,
  getDailyMetricAccumulatorKey,
  ignoredCalorieExpenditureTypes,
  pointInTimeDailyMetricTypes,
} from "../routers/health-kit-sync-schemas.ts";
import { ensurePushProvider } from "./push-provider-repository.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROVIDER_ID = "apple_health";
const BATCH_SIZE = 500;

/** daily_metrics columns that are integer/smallint and require Math.round() before insert */
const INTEGER_DAILY_COLUMNS = new Set([
  "steps",
  "flights_climbed",
  "exercise_minutes",
  "stand_hours",
]);

/** Metric stream channels that are smallint/integer and require Math.round() before publish */
const INTEGER_METRIC_STREAM_COLUMNS = new Set([
  "heart_rate",
  "power",
  "cadence",
  "accumulated_power",
  "stress",
]);

const MAX_SLEEP_SESSION_GAP_MS = 90 * 60 * 1000;

type HealthKitSyncDatabase = SyncDatabase & Pick<Database, "transaction">;

const ignoredProviderDerivedTypes = new Set([
  "HKQuantityTypeIdentifierRestingHeartRate",
  "HKQuantityTypeIdentifierVO2Max",
]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HealthKitSample {
  type: string;
  value: number;
  unit: string;
  startDate: string;
  endDate: string;
  sourceName: string;
  sourceBundle: string;
  uuid: string;
}

export interface WorkoutSample {
  uuid: string;
  workoutType: string;
  startDate: string;
  endDate: string;
  duration: number;
  totalDistance?: number | null;
  sourceName: string;
  sourceBundle: string;
}

export interface SleepSample {
  uuid: string;
  startDate: string;
  endDate: string;
  value: string;
  sourceName: string;
}

// ---------------------------------------------------------------------------
// Type routing maps
// ---------------------------------------------------------------------------

/** Body measurement types and their column names */
const bodyMeasurementTypes: Record<
  string,
  { column: string; transform?: (value: number) => number }
> = {
  HKQuantityTypeIdentifierBodyMass: { column: "weight_kg" },
  HKQuantityTypeIdentifierBodyFatPercentage: {
    column: "body_fat_pct",
    transform: (value) => value * 100,
  },
  HKQuantityTypeIdentifierBodyMassIndex: { column: "bmi" },
  HKQuantityTypeIdentifierHeight: { column: "height_cm" },
};

/** Metric stream types and their column names */
const metricStreamTypes: Record<string, { column: string }> = {
  HKQuantityTypeIdentifierHeartRate: { column: "heart_rate" },
  HKQuantityTypeIdentifierOxygenSaturation: { column: "spo2" },
  HKQuantityTypeIdentifierRespiratoryRate: { column: "respiratory_rate" },
  HKQuantityTypeIdentifierBloodGlucose: { column: "blood_glucose" },
  HKQuantityTypeIdentifierEnvironmentalAudioExposure: { column: "audio_exposure" },
  HKQuantityTypeIdentifierAppleSleepingWristTemperature: { column: "skin_temperature" },
};

const HEALTHKIT_STAGE_MAP: Record<string, string> = {
  asleepDeep: "deep",
  asleepCore: "light",
  asleep: "light",
  asleepUnspecified: "light",
  asleepREM: "rem",
  awake: "awake",
};

// ---------------------------------------------------------------------------
// Pure helper functions (exported for testing)
// ---------------------------------------------------------------------------

/** Extract date string (YYYY-MM-DD) from an ISO timestamp. */
export function extractDate(isoString: string): string {
  return isoString.slice(0, 10);
}

function parseIsoTimestamp(value: string): number | null {
  const milliseconds = Date.parse(value);
  if (Number.isNaN(milliseconds)) return null;
  return milliseconds;
}

export function isSleepStageValue(value: string): boolean {
  return (
    value === "asleep" ||
    value === "asleepUnspecified" ||
    value === "asleepCore" ||
    value === "asleepDeep" ||
    value === "asleepREM"
  );
}

export function deriveSleepSessionsFromStages(samples: SleepSample[]): SleepSample[] {
  const sessions: SleepSample[] = [];
  const bySource = new Map<string, SleepSample[]>();

  for (const sample of samples) {
    if (!isSleepStageValue(sample.value) && sample.value !== "awake") continue;
    const sourceSamples = bySource.get(sample.sourceName) ?? [];
    sourceSamples.push(sample);
    bySource.set(sample.sourceName, sourceSamples);
  }

  for (const [sourceName, sourceSamples] of bySource) {
    const sorted = sourceSamples
      .map((sample) => ({
        sample,
        startMs: parseIsoTimestamp(sample.startDate),
        endMs: parseIsoTimestamp(sample.endDate),
      }))
      .filter((entry): entry is { sample: SleepSample; startMs: number; endMs: number } => {
        if (entry.startMs === null || entry.endMs === null) return false;
        return entry.endMs > entry.startMs;
      })
      .sort((firstEntry, secondEntry) => firstEntry.startMs - secondEntry.startMs);

    if (sorted.length === 0) continue;

    const firstEntry = sorted[0];
    if (!firstEntry) continue;

    let currentStart = firstEntry.startMs;
    let currentEnd = firstEntry.endMs;
    let currentUuid = firstEntry.sample.uuid;
    let currentHasSleepStage = isSleepStageValue(firstEntry.sample.value);

    for (let index = 1; index < sorted.length; index++) {
      const entry = sorted[index];
      if (!entry) continue;

      if (entry.startMs <= currentEnd + MAX_SLEEP_SESSION_GAP_MS) {
        if (entry.endMs > currentEnd) {
          currentEnd = entry.endMs;
        }
        if (isSleepStageValue(entry.sample.value)) {
          currentHasSleepStage = true;
        }
        continue;
      }

      if (currentHasSleepStage) {
        sessions.push({
          uuid: currentUuid,
          startDate: new Date(currentStart).toISOString(),
          endDate: new Date(currentEnd).toISOString(),
          value: "inBed",
          sourceName,
        });
      }

      currentStart = entry.startMs;
      currentEnd = entry.endMs;
      currentUuid = entry.sample.uuid;
      currentHasSleepStage = isSleepStageValue(entry.sample.value);
    }

    if (currentHasSleepStage) {
      sessions.push({
        uuid: currentUuid,
        startDate: new Date(currentStart).toISOString(),
        endDate: new Date(currentEnd).toISOString(),
        value: "inBed",
        sourceName,
      });
    }
  }

  return sessions;
}

function mapHealthKitStage(value: string): string | null {
  return HEALTHKIT_STAGE_MAP[value] ?? null;
}

/** Route a sample to its destination category */
export function categorize(
  type: string,
):
  | "bodyMeasurement"
  | "additiveDailyMetric"
  | "pointInTimeDailyMetric"
  | "metricStream"
  | "ignored"
  | "healthEvent" {
  if (ignoredCalorieExpenditureTypes.has(type) || ignoredProviderDerivedTypes.has(type)) {
    return "ignored";
  }
  if (type in bodyMeasurementTypes) return "bodyMeasurement";
  if (type in additiveDailyMetricTypes) return "additiveDailyMetric";
  if (type in pointInTimeDailyMetricTypes) return "pointInTimeDailyMetric";
  if (type in metricStreamTypes) return "metricStream";
  return "healthEvent";
}

function createEmptyAccumulator(): DailyMetricAccumulator {
  return {
    steps: null,
    distanceKm: null,
    flightsClimbed: null,
    exerciseMinutes: null,
    hrv: null,
    walkingSpeed: null,
    walkingStepLength: null,
    walkingDoubleSupportPct: null,
    walkingAsymmetryPct: null,
    walkingSteadiness: null,
  };
}

/** Aggregate daily metrics per (date, source). Key is "date\0sourceName". */
export function aggregateDailyMetricSamples(
  samples: HealthKitSample[],
): Map<string, DailyMetricAccumulator> {
  const byDateSource = new Map<string, DailyMetricAccumulator>();
  const heartRateVariabilitySamplesByDateSource = new Map<
    string,
    Array<{ value: number; startDate: string }>
  >();

  for (const sample of samples) {
    const dateStr = extractDate(sample.startDate);
    const compoundKey = `${dateStr}\0${sample.sourceName}`;
    let accumulator = byDateSource.get(compoundKey);
    if (!accumulator) {
      accumulator = createEmptyAccumulator();
      byDateSource.set(compoundKey, accumulator);
    }

    const additiveMapping = additiveDailyMetricTypes[sample.type];
    if (additiveMapping) {
      const value = additiveMapping.transform
        ? additiveMapping.transform(sample.value)
        : sample.value;
      const key = additiveMapping.accumulatorKey;
      accumulator[key] = (accumulator[key] ?? 0) + value;
      continue;
    }

    const pointMapping = pointInTimeDailyMetricTypes[sample.type];
    if (!pointMapping) continue;

    if (pointMapping.column === "hrv") {
      const daySamples = heartRateVariabilitySamplesByDateSource.get(compoundKey) ?? [];
      daySamples.push({ value: sample.value, startDate: sample.startDate });
      heartRateVariabilitySamplesByDateSource.set(compoundKey, daySamples);
      continue;
    }

    const key = getDailyMetricAccumulatorKey(pointMapping.column);
    accumulator[key] = sample.value;
  }

  // Select overnight HRV for each (date, source) using shared logic
  for (const [
    compoundKey,
    heartRateVariabilitySamples,
  ] of heartRateVariabilitySamplesByDateSource) {
    const accumulator = byDateSource.get(compoundKey);
    if (accumulator) {
      accumulator.hrv = selectDailyHeartRateVariability(heartRateVariabilitySamples);
    }
  }

  return byDateSource;
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export class HealthKitDeletionTombstonesUnsupportedError extends Error {
  constructor() {
    super("Metric stream publisher does not support HealthKit deletion tombstones");
    this.name = "HealthKitDeletionTombstonesUnsupportedError";
  }
}

/** Data access for HealthKit sync operations (inserts, upserts, batch writes). */
export class HealthKitSyncRepository {
  readonly #db: HealthKitSyncDatabase;
  readonly #userId: string;
  readonly #metricStreamPublisher?: MetricStreamEventPublisher;

  constructor(
    db: HealthKitSyncDatabase,
    userId: string,
    metricStreamPublisher?: MetricStreamEventPublisher,
  ) {
    this.#db = db;
    this.#userId = userId;
    this.#metricStreamPublisher = metricStreamPublisher;
  }

  async #publisher(): Promise<MetricStreamEventPublisher> {
    return this.#metricStreamPublisher ?? getDefaultMetricStreamEventPublisher();
  }

  /** Ensure the apple_health provider row exists */
  async ensureProvider(): Promise<void> {
    await ensurePushProvider({
      database: this.#db,
      providerId: PROVIDER_ID,
      providerName: "Apple Health",
      userId: this.#userId,
    });
  }

  /** Apply anchored-query deletions to UUID-addressable canonical stores. */
  async processDeletedQuantitySamples(
    typeIdentifier: string,
    deletedUUIDs: string[],
  ): Promise<number> {
    const uniqueUUIDs = [...new Set(deletedUUIDs)];
    if (uniqueUUIDs.length === 0) {
      return 0;
    }

    if (bodyMeasurementTypes[typeIdentifier] || metricStreamTypes[typeIdentifier]) {
      const publisher = await this.#publisher();
      const replaceRows = publisher.replaceRows?.bind(publisher);
      if (!replaceRows) {
        throw new HealthKitDeletionTombstonesUnsupportedError();
      }
      const context = await getProviderDataGenerations(this.#db, [
        { providerId: PROVIDER_ID, userId: this.#userId },
      ]);
      await Promise.all(
        uniqueUUIDs.map((uuid) =>
          replaceRows(
            {
              userId: this.#userId,
              providerId: PROVIDER_ID,
              externalId: `hk:${uuid}`,
            },
            [],
            context.operationRevision,
          ),
        ),
      );
      return uniqueUUIDs.length;
    }

    const externalIds = uniqueUUIDs.map((uuid) => `hk:${uuid}`);
    const deletedRows = await executeWithSchema(
      this.#db,
      z.object({ externalId: z.string() }),
      sql`DELETE FROM fitness.health_event
          WHERE user_id = ${this.#userId}
            AND provider_id = ${PROVIDER_ID}
            AND external_id IN (${sql.join(
              externalIds.map((externalId) => sql`${externalId}`),
              sql`, `,
            )})
          RETURNING external_id AS "externalId"`,
    );
    return deletedRows.length;
  }

  /** Process body measurement samples */
  async processBodyMeasurements(samples: HealthKitSample[]): Promise<number> {
    let inserted = 0;
    for (let index = 0; index < samples.length; index += BATCH_SIZE) {
      const batch = samples.slice(index, index + BATCH_SIZE);
      const rows: MetricStreamRowInput[] = [];
      for (const sample of batch) {
        const mapping = bodyMeasurementTypes[sample.type];
        if (!mapping) continue;
        const value = mapping.transform ? mapping.transform(sample.value) : sample.value;
        const externalId = `hk:${sample.uuid}`;
        const channel = BODY_MEASUREMENT_COLUMN_TO_CHANNEL[mapping.column];
        if (!channel) {
          throw new Error(
            `Missing metric stream channel mapping for body column: ${mapping.column}`,
          );
        }

        rows.push({
          recordedAt: sample.startDate,
          userId: this.#userId,
          providerId: PROVIDER_ID,
          externalId,
          deviceId: sample.sourceName,
          sourceType: SOURCE_TYPE_API,
          channel,
          scalar: value,
        });
      }

      if (rows.length > 0) {
        const publisher = await this.#publisher();
        const result = await writeMetricStreamRows({ database: this.#db, publisher, rows });
        inserted += result.published;
      }
    }
    return inserted;
  }

  /** Process daily metric samples (both additive and point-in-time) */
  async processDailyMetrics(samples: HealthKitSample[]): Promise<number> {
    const byDateSource = aggregateDailyMetricSamples(samples);

    // Upsert each (date, source)
    for (const [compoundKey, accumulator] of byDateSource) {
      const [dateStr, sourceName] = compoundKey.split("\0");
      const setClauses: ReturnType<typeof sql>[] = [];
      const insertColumns: ReturnType<typeof sql>[] = [];
      const insertValues: ReturnType<typeof sql>[] = [];

      insertColumns.push(sql`date`);
      insertValues.push(sql`${dateStr}::date`);
      insertColumns.push(sql`provider_id`);
      insertValues.push(sql`${PROVIDER_ID}`);
      insertColumns.push(sql`user_id`);
      insertValues.push(sql`${this.#userId}`);
      insertColumns.push(sql`source_name`);
      insertValues.push(sql`${sourceName ?? null}`);

      // Additive fields: replace with the complete day-total from this sync.
      const additiveFields: Array<{ column: string; key: AdditiveDailyMetricAccumulatorKey }> = [
        { column: "steps", key: "steps" },
        { column: "distance_km", key: "distanceKm" },
        { column: "flights_climbed", key: "flightsClimbed" },
        { column: "exercise_minutes", key: "exerciseMinutes" },
      ];

      for (const { column, key } of additiveFields) {
        const raw = accumulator[key];
        if (raw !== null) {
          const value = INTEGER_DAILY_COLUMNS.has(column) ? Math.round(raw) : raw;
          insertColumns.push(sql`${sql.identifier(column)}`);
          insertValues.push(sql`${value}`);
          setClauses.push(sql`${sql.identifier(column)} = EXCLUDED.${sql.identifier(column)}`);
        }
      }

      // Point-in-time fields
      const pointFields: Array<{ column: string; key: keyof DailyMetricAccumulator }> = [
        { column: "hrv", key: "hrv" },
        { column: "walking_speed", key: "walkingSpeed" },
        { column: "walking_step_length", key: "walkingStepLength" },
        { column: "walking_double_support_pct", key: "walkingDoubleSupportPct" },
        { column: "walking_asymmetry_pct", key: "walkingAsymmetryPct" },
        { column: "walking_steadiness", key: "walkingSteadiness" },
      ];

      for (const { column, key } of pointFields) {
        const raw = accumulator[key];
        if (raw !== null) {
          const value = INTEGER_DAILY_COLUMNS.has(column) ? Math.round(raw) : raw;
          insertColumns.push(sql`${sql.identifier(column)}`);
          insertValues.push(sql`${value}`);
          setClauses.push(sql`${sql.identifier(column)} = EXCLUDED.${sql.identifier(column)}`);
        }
      }

      if (setClauses.length === 0) continue;

      const columnsSql = sql.join(insertColumns, sql`, `);
      const valuesSql = sql.join(insertValues, sql`, `);
      const setSql = sql.join(setClauses, sql`, `);

      await this.#db.execute(
        sql`INSERT INTO fitness.daily_metrics (${columnsSql})
            VALUES (${valuesSql})
            ON CONFLICT (user_id, date, provider_id, source_name) DO UPDATE SET ${setSql}`,
      );
    }

    return samples.length;
  }

  /** Process metric streams */
  async processMetricStream(samples: HealthKitSample[]): Promise<number> {
    let inserted = 0;
    for (let index = 0; index < samples.length; index += BATCH_SIZE) {
      const batch = samples.slice(index, index + BATCH_SIZE);
      const rows: MetricStreamRowInput[] = [];
      for (const sample of batch) {
        const mapping = metricStreamTypes[sample.type];
        if (!mapping) continue;

        const metricValue = INTEGER_METRIC_STREAM_COLUMNS.has(mapping.column)
          ? Math.round(sample.value)
          : sample.value;
        const externalId = `hk:${sample.uuid}`;
        rows.push({
          recordedAt: sample.startDate,
          userId: this.#userId,
          providerId: PROVIDER_ID,
          externalId,
          deviceId: sample.sourceName,
          sourceType: SOURCE_TYPE_API,
          channel: mapping.column,
          scalar: metricValue,
        });
      }

      if (rows.length > 0) {
        const publisher = await this.#publisher();
        const result = await writeMetricStreamRows({ database: this.#db, publisher, rows });
        inserted += result.published;
      }
    }
    return inserted;
  }

  /** Process health event samples (catch-all) */
  async processHealthEvents(samples: HealthKitSample[]): Promise<number> {
    let inserted = 0;
    for (let index = 0; index < samples.length; index += BATCH_SIZE) {
      const batch = samples.slice(index, index + BATCH_SIZE);
      for (const sample of batch) {
        const externalId = `hk:${sample.uuid}`;
        await this.#db.execute(
          sql`INSERT INTO fitness.health_event (user_id, provider_id, external_id, type, value, unit, source_name, start_date, end_date)
              VALUES (${this.#userId}, ${PROVIDER_ID}, ${externalId}, ${sample.type}, ${sample.value}, ${sample.unit}, ${sample.sourceName}, ${sample.startDate}::timestamptz, ${sample.endDate}::timestamptz)
              ON CONFLICT (user_id, provider_id, external_id) DO NOTHING`,
        );
        inserted++;
      }
    }
    return inserted;
  }

  /** Process workout samples */
  async processWorkouts(
    workouts: WorkoutSample[],
    options?: { windowStart?: string; windowEnd?: string },
  ): Promise<number> {
    if (workouts.length === 0) return 0;

    let windowStart = options?.windowStart;
    let windowEnd = options?.windowEnd;
    if (!windowStart || !windowEnd) {
      const bounds = computeBoundsFromIsoTimestamps(
        workouts.flatMap((workout) => [workout.startDate, workout.endDate]),
      );
      if (!bounds) {
        throw new Error("Cannot derive workout sync window from workout timestamps");
      }
      windowStart = windowStart ?? bounds.startAt;
      windowEnd = windowEnd ?? bounds.endAt;
    }

    const parsedWindowStart = new Date(windowStart);
    const parsedWindowEnd = new Date(windowEnd);
    if (
      Number.isNaN(parsedWindowStart.getTime()) ||
      Number.isNaN(parsedWindowEnd.getTime()) ||
      parsedWindowStart >= parsedWindowEnd
    ) {
      throw new Error("Invalid workout sync window");
    }

    return processWorkoutsShared(this.#db, this.#userId, workouts, {
      windowStart: parsedWindowStart.toISOString(),
      windowEnd: parsedWindowEnd.toISOString(),
    });
  }

  /** Process sleep samples, grouping by inBed boundaries */
  async processSleepSamples(samples: SleepSample[]): Promise<number> {
    const explicitInBedSamples = samples.filter((sample) => sample.value === "inBed");
    const inBedSamples =
      explicitInBedSamples.length > 0
        ? explicitInBedSamples
        : deriveSleepSessionsFromStages(samples);
    const stageSamples = samples.filter((sample) => sample.value !== "inBed");

    if (inBedSamples.length === 0) return 0;

    let inserted = 0;
    for (const session of inBedSamples) {
      const sessionStart = new Date(session.startDate).getTime();
      const sessionEnd = new Date(session.endDate).getTime();

      // Filter stages that overlap this session
      const overlapping = stageSamples.filter((stage) => {
        const stageStart = new Date(stage.startDate).getTime();
        const stageEnd = new Date(stage.endDate).getTime();
        return stageStart >= sessionStart && stageEnd <= sessionEnd;
      });

      // Group stages by source so each source gets its own row.
      const stagesBySource = new Map<string, SleepSample[]>();
      for (const stage of overlapping) {
        const existing = stagesBySource.get(stage.sourceName) ?? [];
        existing.push(stage);
        stagesBySource.set(stage.sourceName, existing);
      }

      const durationMinutes = Math.round((sessionEnd - sessionStart) / (1000 * 60));

      // Clean up legacy single-source row (old format without source suffix)
      const legacyExternalId = `hk:sleep:${session.uuid}`;
      await this.#db.execute(
        sql`DELETE FROM fitness.sleep_session
            WHERE user_id = ${this.#userId} AND provider_id = ${PROVIDER_ID} AND external_id = ${legacyExternalId}`,
      );

      // Determine sources to insert: one row per source, or one row with session source if no stages
      const sources: Array<[string, SleepSample[]]> =
        stagesBySource.size > 0 ? [...stagesBySource.entries()] : [[session.sourceName, []]];

      for (const [sourceName, stages] of sources) {
        const stagingAvailable = stages.some(
          (stage) =>
            stage.value === "asleepCore" ||
            stage.value === "asleepDeep" ||
            stage.value === "asleepREM",
        );
        const startUtcOffsetMinutes = offsetMinutesFromTimestamp(session.startDate);
        const endUtcOffsetMinutes = offsetMinutesFromTimestamp(session.endDate);
        const localTimeContext =
          startUtcOffsetMinutes == null || endUtcOffsetMinutes == null
            ? {
                timezone: null,
                startUtcOffsetMinutes: null,
                endUtcOffsetMinutes: null,
                source: "unknown" as const,
              }
            : resolveRecordLocalTimeContext({
                startedAt: new Date(session.startDate),
                endedAt: new Date(session.endDate),
                startUtcOffsetMinutes,
                endUtcOffsetMinutes,
                source: "device_offset",
              });
        let deepMinutes = 0;
        let remMinutes = 0;
        let lightMinutes = 0;
        let awakeMinutes = 0;

        for (const stage of stages) {
          const stageStart = new Date(stage.startDate).getTime();
          const stageEnd = new Date(stage.endDate).getTime();
          const stageDuration = Math.round((stageEnd - stageStart) / (1000 * 60));
          switch (stage.value) {
            case "asleep":
            case "asleepUnspecified":
              lightMinutes += stageDuration;
              break;
            case "asleepDeep":
              deepMinutes += stageDuration;
              break;
            case "asleepREM":
              remMinutes += stageDuration;
              break;
            case "asleepCore":
              lightMinutes += stageDuration;
              break;
            case "awake":
              awakeMinutes += stageDuration;
              break;
          }
        }

        const externalId = `hk:sleep:${session.uuid}:${sourceName}`;
        const storedDeepMinutes = stagingAvailable ? deepMinutes : null;
        const storedRemMinutes = stagingAvailable ? remMinutes : null;
        const storedLightMinutes = stagingAvailable ? lightMinutes : null;
        const storedAwakeMinutes =
          stagingAvailable || stages.some((stage) => stage.value === "awake") ? awakeMinutes : null;
        const sessionResult = await executeWithSchema(
          this.#db,
          z.object({ id: z.guid() }),
          sql`INSERT INTO fitness.sleep_session (user_id, provider_id, external_id, started_at, ended_at, timezone, start_utc_offset_minutes, end_utc_offset_minutes, local_time_source, duration_minutes, deep_minutes, rem_minutes, light_minutes, awake_minutes, staging_available, sleep_type, source_name)
              VALUES (
                ${this.#userId},
                ${PROVIDER_ID},
                ${externalId},
                ${session.startDate}::timestamptz,
                ${session.endDate}::timestamptz,
                ${localTimeContext.timezone},
                ${localTimeContext.startUtcOffsetMinutes},
                ${localTimeContext.endUtcOffsetMinutes},
                ${localTimeContext.source},
                ${durationMinutes},
                ${storedDeepMinutes},
                ${storedRemMinutes},
                ${storedLightMinutes},
                ${storedAwakeMinutes},
                ${stagingAvailable},
                ${null},
                ${sourceName}
              )
              ON CONFLICT (user_id, provider_id, external_id) DO UPDATE SET
                started_at = ${session.startDate}::timestamptz,
                ended_at = ${session.endDate}::timestamptz,
                timezone = ${localTimeContext.timezone},
                start_utc_offset_minutes = ${localTimeContext.startUtcOffsetMinutes},
                end_utc_offset_minutes = ${localTimeContext.endUtcOffsetMinutes},
                local_time_source = ${localTimeContext.source},
                duration_minutes = ${durationMinutes},
                deep_minutes = ${storedDeepMinutes},
                rem_minutes = ${storedRemMinutes},
                light_minutes = ${storedLightMinutes},
                awake_minutes = ${storedAwakeMinutes},
                staging_available = ${stagingAvailable},
                sleep_type = ${null},
                source_name = ${sourceName}
              RETURNING id`,
        );

        // Insert individual sleep stage intervals
        const sessionId = sessionResult[0]?.id;
        if (sessionId && stages.length > 0) {
          await this.#db.execute(
            sql`DELETE FROM fitness.sleep_stage WHERE session_id = ${sessionId}::uuid`,
          );

          const stageValues = stages
            .map((stage) => {
              const mapped = mapHealthKitStage(stage.value);
              if (!mapped) return null;
              return sql`(${sessionId}::uuid, ${mapped}, ${stage.startDate}::timestamptz, ${stage.endDate}::timestamptz, ${stage.sourceName})`;
            })
            .filter((value): value is NonNullable<typeof value> => value !== null);

          if (stageValues.length > 0) {
            await this.#db.execute(
              sql`INSERT INTO fitness.sleep_stage (session_id, stage, started_at, ended_at, source_name)
                  VALUES ${sql.join(stageValues, sql`, `)}`,
            );
          }
        }

        inserted++;
      }
    }

    return inserted;
  }
}
