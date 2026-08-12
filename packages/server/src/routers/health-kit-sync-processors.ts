import {
  offsetMinutesFromTimestamp,
  resolveRecordLocalTimeContext,
} from "@dofek/format/record-local-time";
import { selectDailyHeartRateVariability } from "@dofek/heart-rate-variability";
import { resolveProviderActivityType } from "@dofek/training/activity-types";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { Database as DrizzleDatabase, SyncDatabase } from "../../../../src/db/index.ts";
import { ProviderActivityListSync } from "../../../../src/db/provider-activity-sync.ts";
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
import { replaceHangTenIntervals } from "../../../../src/providers/apple-health/hang-ten-intervals.ts";
import {
  buildAppleHealthWorkoutIdentity,
  collectAppleHealthWorkoutIdentities,
} from "../../../../src/providers/apple-health/workout-identity.ts";
import { applyWorkoutMetadata } from "../../../../src/providers/apple-health/workouts.ts";
import { canonicalizeTimestampForExternalId } from "../lib/canonical-timestamp.ts";
import { computeBoundsFromIsoTimestamps } from "../lib/health-kit-sync-helpers.ts";
import { executeWithSchema } from "../lib/typed-sql.ts";
import { logger } from "../logger.ts";
import {
  type AdditiveDailyMetricAccumulatorKey,
  additiveDailyMetricTypes,
  BATCH_SIZE,
  bodyMeasurementTypes,
  createEmptyAccumulator,
  type DailyMetricAccumulator,
  type Database,
  getDailyMetricAccumulatorKey,
  type HealthKitSample,
  INTEGER_DAILY_COLUMNS,
  INTEGER_METRIC_STREAM_COLUMNS,
  metricStreamTypes,
  PROVIDER_ID,
  pointInTimeDailyMetricTypes,
  ROUTE_CHANNELS,
  type WorkoutRoute,
  type WorkoutSample,
  workoutActivityTypeMap,
} from "./health-kit-sync-schemas.ts";

/** Extract date string (YYYY-MM-DD) from an ISO timestamp.
 *
 * When the timestamp includes a timezone offset (e.g. "2024-01-14T21:30:00-0700"),
 * the first 10 characters are the local date. For UTC timestamps ending in "Z",
 * the first 10 characters are the UTC date — which may differ from the user's
 * local date for evening readings. The iOS app should send local-timezone offsets
 * so this function returns the correct calendar date.
 */
function extractDate(isoString: string): string {
  return isoString.slice(0, 10);
}

export { computeBoundsFromIsoTimestamps };

type WorkoutSyncDatabase = SyncDatabase & Pick<DrizzleDatabase, "transaction">;

function dateInTimezone(timestamp: string, timezone: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return extractDate(timestamp);

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) return extractDate(timestamp);
  return `${year}-${month}-${day}`;
}

async function upsertDailyAverageFromSamples(
  db: Database,
  userId: string,
  samples: HealthKitSample[],
  sampleType: string,
  column: "skin_temp_c" | "spo2_avg",
  valueScale: number,
  timezone: string,
): Promise<void> {
  const groupedSamples = new Map<string, { total: number; count: number; sourceName: string }>();

  for (const sample of samples) {
    if (sample.type !== sampleType) continue;
    const date = dateInTimezone(sample.startDate, timezone);
    const key = `${date}\0${sample.sourceName}`;
    const grouped = groupedSamples.get(key) ?? {
      total: 0,
      count: 0,
      sourceName: sample.sourceName,
    };
    grouped.total += sample.value * valueScale;
    grouped.count++;
    groupedSamples.set(key, grouped);
  }

  for (const [key, grouped] of groupedSamples) {
    if (grouped.count === 0) continue;
    const [date] = key.split("\0");
    const average = grouped.total / grouped.count;
    await db.execute(
      sql`INSERT INTO fitness.daily_metrics (
            date,
            provider_id,
            user_id,
            source_name,
            ${sql.identifier(column)}
          )
          VALUES (
            ${date}::date,
            ${PROVIDER_ID},
            ${userId},
            ${grouped.sourceName},
            ${average}
          )
          ON CONFLICT (user_id, date, provider_id, source_name) DO UPDATE SET
            ${sql.identifier(column)} = EXCLUDED.${sql.identifier(column)}`,
    );
  }
}

/** Process body measurement samples */
export async function processBodyMeasurements(
  db: Database,
  userId: string,
  samples: HealthKitSample[],
  publisher?: MetricStreamEventPublisher,
): Promise<number> {
  const resolvedPublisher = publisher ?? (await getDefaultMetricStreamEventPublisher());
  let inserted = 0;
  for (let i = 0; i < samples.length; i += BATCH_SIZE) {
    const batch = samples.slice(i, i + BATCH_SIZE);
    const rows: MetricStreamRowInput[] = [];
    for (const sample of batch) {
      const mapping = bodyMeasurementTypes[sample.type];
      if (!mapping) continue;
      const value = mapping.transform ? mapping.transform(sample.value) : sample.value;
      const externalId = `hk:${sample.uuid}`;
      const channel = BODY_MEASUREMENT_COLUMN_TO_CHANNEL[mapping.column];
      if (!channel) {
        throw new Error(`Missing metric_stream channel mapping for body column: ${mapping.column}`);
      }

      rows.push({
        recordedAt: sample.startDate,
        userId,
        providerId: PROVIDER_ID,
        externalId,
        deviceId: sample.sourceName,
        sourceType: SOURCE_TYPE_API,
        channel,
        scalar: value,
      });
      inserted++;
    }
    await writeMetricStreamRows({ database: db, publisher: resolvedPublisher, rows });
  }
  return inserted;
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

/** Process daily metric samples (both additive and point-in-time) */
export async function processDailyMetrics(
  db: Database,
  userId: string,
  samples: HealthKitSample[],
): Promise<number> {
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
    insertValues.push(sql`${userId}`);
    insertColumns.push(sql`source_name`);
    insertValues.push(sql`${sourceName ?? null}`);

    // Additive fields: replace with the complete day-total from this sync.
    // Each iOS sync sends all samples for the 7-day window, so the in-memory
    // accumulator already contains the full sum — no need to add to existing.
    const additiveFields: Array<{ column: string; key: AdditiveDailyMetricAccumulatorKey }> = [
      { column: "steps", key: "steps" },
      { column: "distance_km", key: "distanceKm" },
      { column: "flights_climbed", key: "flightsClimbed" },
      { column: "exercise_minutes", key: "exerciseMinutes" },
    ];

    for (const { column, key } of additiveFields) {
      const raw = accumulator[key];
      if (raw !== null) {
        // Integer columns (steps, flights_climbed, exercise_minutes) need rounding;
        // real columns such as distance_km do not.
        const value = INTEGER_DAILY_COLUMNS.has(column) ? Math.round(raw) : raw;
        insertColumns.push(sql`${sql.identifier(column)}`);
        insertValues.push(sql`${value}`);
        setClauses.push(sql`${sql.identifier(column)} = EXCLUDED.${sql.identifier(column)}`);
      }
    }

    // Point-in-time fields: overwrite with aggregated day values (HRV is day-averaged upstream)
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

    await db.execute(
      sql`INSERT INTO fitness.daily_metrics (${columnsSql})
          VALUES (${valuesSql})
          ON CONFLICT (user_id, date, provider_id, source_name) DO UPDATE SET ${setSql}`,
    );
  }

  return samples.length;
}

/** Process metric streams */
export async function processMetricStream(
  db: Database,
  userId: string,
  samples: HealthKitSample[],
  publisher?: MetricStreamEventPublisher,
): Promise<number> {
  const resolvedPublisher = publisher ?? (await getDefaultMetricStreamEventPublisher());
  let inserted = 0;
  for (let i = 0; i < samples.length; i += BATCH_SIZE) {
    const batch = samples.slice(i, i + BATCH_SIZE);
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
        userId,
        providerId: PROVIDER_ID,
        externalId,
        deviceId: sample.sourceName ?? null,
        sourceType: "api",
        channel: mapping.column,
        scalar: metricValue,
      });
      inserted++;
    }
    await writeMetricStreamRows({ database: db, publisher: resolvedPublisher, rows });
  }
  return inserted;
}

/** Process health event samples (catch-all) */
export async function processHealthEvents(
  db: Database,
  userId: string,
  samples: HealthKitSample[],
): Promise<number> {
  let inserted = 0;
  for (let i = 0; i < samples.length; i += BATCH_SIZE) {
    const batch = samples.slice(i, i + BATCH_SIZE);
    for (const sample of batch) {
      const externalId = `hk:${sample.uuid}`;
      await db.execute(
        sql`INSERT INTO fitness.health_event (user_id, provider_id, external_id, type, value, unit, source_name, start_date, end_date)
            VALUES (${userId}, ${PROVIDER_ID}, ${externalId}, ${sample.type}, ${sample.value}, ${sample.unit}, ${sample.sourceName}, ${sample.startDate}::timestamptz, ${sample.endDate}::timestamptz)
            ON CONFLICT (user_id, provider_id, external_id) DO NOTHING`,
      );
      inserted++;
    }
  }
  return inserted;
}

export function appleHealthWorkoutExternalId(uuid: string): string {
  return `hk:workout:${uuid}`;
}

export interface ProcessWorkoutsOptions {
  windowStart: string;
  windowEnd: string;
}

function appleHealthLocalTimeContext(startTimestamp: string, endTimestamp: string) {
  const startedAt = new Date(startTimestamp);
  const endedAt = new Date(endTimestamp);
  const startUtcOffsetMinutes = offsetMinutesFromTimestamp(startTimestamp);
  const endUtcOffsetMinutes = offsetMinutesFromTimestamp(endTimestamp);
  if (startUtcOffsetMinutes == null || endUtcOffsetMinutes == null) {
    return {
      timezone: null,
      startUtcOffsetMinutes: null,
      endUtcOffsetMinutes: null,
      localTimeSource: "unknown" as const,
    };
  }
  const context = resolveRecordLocalTimeContext({
    startedAt,
    endedAt,
    startUtcOffsetMinutes,
    endUtcOffsetMinutes,
    source: "device_offset",
  });
  return {
    timezone: context.timezone,
    startUtcOffsetMinutes: context.startUtcOffsetMinutes,
    endUtcOffsetMinutes: context.endUtcOffsetMinutes,
    localTimeSource: context.source,
  };
}

/** Process workout samples */
export async function processWorkouts(
  db: WorkoutSyncDatabase,
  userId: string,
  workouts: WorkoutSample[],
  options: ProcessWorkoutsOptions,
): Promise<number> {
  const activitySync = new ProviderActivityListSync({
    db,
    providerId: PROVIDER_ID,
    userId,
    windowStart: new Date(options.windowStart),
    windowEnd: new Date(options.windowEnd),
  });

  let inserted = 0;
  for (const workout of workouts) {
    const normalizedWorkout = applyWorkoutMetadata(
      {
        activityType: resolveProviderActivityType(
          workout.workoutType,
          workoutActivityTypeMap[workout.workoutType] ?? "other",
        ),
        sourceName: workout.sourceName,
        durationSeconds: workout.duration,
        distanceMeters: workout.totalDistance ?? undefined,
        startDate: new Date(workout.startDate),
        endDate: new Date(workout.endDate),
      },
      workout.metadata ?? {},
    );

    const rawData = {
      duration: workout.duration,
      totalDistance: workout.totalDistance,
      sourceName: workout.sourceName,
      workoutType: workout.workoutType,
      metadata: workout.metadata,
      workoutActivities: workout.workoutActivities,
      ...(normalizedWorkout.hangTen ? { hangTen: normalizedWorkout.hangTen } : {}),
    };

    const values = {
      userId,
      providerId: PROVIDER_ID,
      externalId: appleHealthWorkoutExternalId(workout.uuid),
      activityType: normalizedWorkout.activityType,
      startedAt: normalizedWorkout.startDate,
      endedAt: normalizedWorkout.endDate,
      name: normalizedWorkout.hangTen?.planName,
      sourceName: normalizedWorkout.sourceName,
      ...appleHealthLocalTimeContext(workout.startDate, workout.endDate),
      raw: rawData,
    };
    await db.transaction(async (transactionDb) => {
      const returned = await activitySync.upsert(
        values,
        {
          activityType: normalizedWorkout.activityType,
          startedAt: normalizedWorkout.startDate,
          endedAt: normalizedWorkout.endDate,
          name: normalizedWorkout.hangTen?.planName,
          sourceName: normalizedWorkout.sourceName,
          ...appleHealthLocalTimeContext(workout.startDate, workout.endDate),
          raw: rawData,
        },
        transactionDb,
      );
      if (returned && normalizedWorkout.hangTen) {
        await replaceHangTenIntervals(transactionDb, returned.id, normalizedWorkout);
      }
    });
    inserted++;
  }

  await activitySync.reconcile(undefined, {
    presentAppleHealthIdentities: collectAppleHealthWorkoutIdentities(
      workouts.map((workout) =>
        buildAppleHealthWorkoutIdentity({
          syncIdentifier: workout.metadata?.HKMetadataKeySyncIdentifier,
          startedAt: new Date(workout.startDate),
          endedAt: new Date(workout.endDate),
          sourceName: workout.sourceName,
        }),
      ),
    ),
  });

  return inserted;
}

/** Process workout route locations as location point metrics plus associated scalar metrics. */
export async function processWorkoutRoutes(
  db: Database,
  userId: string,
  routes: WorkoutRoute[],
  publisher?: MetricStreamEventPublisher,
): Promise<number> {
  const resolvedPublisher = publisher ?? (await getDefaultMetricStreamEventPublisher());
  let inserted = 0;

  // Resolve all workoutUuid → activityId mappings in one query to avoid N+1
  const externalIds = Array.from(
    new Set(
      routes
        .filter((route) => route.locations.length > 0)
        .map((route) => `hk:workout:${route.workoutUuid}`),
    ),
  );

  const activityIdByExternalId = new Map<string, string>();

  if (externalIds.length > 0) {
    const activityRowSchema = z.object({ id: z.string(), external_id: z.string() });
    const activityRows = await executeWithSchema(
      db,
      activityRowSchema,
      sql`SELECT id, external_id FROM fitness.activity
          WHERE user_id = ${userId}
            AND provider_id = ${PROVIDER_ID}
            AND external_id IN (${sql.join(
              externalIds.map((externalId) => sql`${externalId}`),
              sql`, `,
            )})`,
    );

    for (const activityRow of activityRows) {
      activityIdByExternalId.set(activityRow.external_id, activityRow.id);
    }
  }

  for (const route of routes) {
    if (route.locations.length === 0) continue;

    const externalId = `hk:workout:${route.workoutUuid}`;
    const activityId = activityIdByExternalId.get(externalId) ?? null;

    if (!activityId) {
      logger.warn(
        `[apple_health] No activity found for workout route ${route.workoutUuid}, skipping`,
      );
      continue;
    }

    const pendingRows: MetricStreamRowInput[] = [];
    const flushPendingRows = async () => {
      if (pendingRows.length === 0) return;
      const events = await writeMetricStreamRows({
        database: db,
        publisher: resolvedPublisher,
        rows: pendingRows,
      });
      inserted += events.published;
      pendingRows.length = 0;
    };

    for (const location of route.locations) {
      const recordedAt = canonicalizeTimestampForExternalId(location.date);
      const locationMetadata =
        location.horizontalAccuracy == null
          ? null
          : { horizontal_accuracy_m: location.horizontalAccuracy };
      const locationExternalId = `${externalId}:location:${recordedAt}`;
      pendingRows.push({
        recordedAt: location.date,
        userId,
        providerId: PROVIDER_ID,
        externalId: locationExternalId,
        activityId,
        deviceId: route.sourceName ?? null,
        sourceType: "api",
        channel: "location",
        scalar: null,
        point: `SRID=4326;POINT(${location.lng} ${location.lat})`,
        metadata: locationMetadata,
      });

      if (pendingRows.length >= BATCH_SIZE) {
        await flushPendingRows();
      }

      for (const { channel, getValue, round } of ROUTE_CHANNELS) {
        const value = getValue(location);
        if (value == null) continue;

        const scalar = round ? Math.round(value) : value;
        const scalarExternalId = `${externalId}:${channel}:${recordedAt}`;
        pendingRows.push({
          recordedAt: location.date,
          userId,
          providerId: PROVIDER_ID,
          externalId: scalarExternalId,
          activityId,
          deviceId: route.sourceName ?? null,
          sourceType: "api",
          channel,
          scalar,
          point: null,
          metadata: null,
        });

        if (pendingRows.length >= BATCH_SIZE) {
          await flushPendingRows();
        }
      }
    }

    await flushPendingRows();
  }

  return inserted;
}

/**
 * Aggregate SpO2 readings from metric_stream into daily_metrics.spo2_avg.
 * Apple Health stores SpO2 as fractions (0-1) in metric_stream; this converts
 * the daily average to a percentage (0-100) for consistency with other providers
 * (WHOOP, Oura, Garmin) that report SpO2 as a percentage.
 */
export async function aggregateSpO2ToDailyMetrics(
  db: Database,
  userId: string,
  samples: HealthKitSample[],
  timezone: string,
): Promise<void> {
  await upsertDailyAverageFromSamples(
    db,
    userId,
    samples,
    "HKQuantityTypeIdentifierOxygenSaturation",
    "spo2_avg",
    100,
    timezone,
  );
}

/**
 * Aggregate wrist temperature readings from metric_stream into daily_metrics.skin_temp_c.
 * Apple Watch reports sleeping wrist temperature in °C; this computes the daily
 * average and stores it alongside other daily metrics.
 */
export async function aggregateSkinTempToDailyMetrics(
  db: Database,
  userId: string,
  samples: HealthKitSample[],
  timezone: string,
): Promise<void> {
  await upsertDailyAverageFromSamples(
    db,
    userId,
    samples,
    "HKQuantityTypeIdentifierAppleSleepingWristTemperature",
    "skin_temp_c",
    1,
    timezone,
  );
}
