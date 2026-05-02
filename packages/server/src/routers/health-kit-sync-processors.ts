import { selectDailyHeartRateVariability } from "@dofek/heart-rate-variability";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema } from "../lib/typed-sql.ts";
import { logger } from "../logger.ts";
import {
  additiveDailyMetricTypes,
  BATCH_SIZE,
  bodyMeasurementTypes,
  columnToAccumulatorKey,
  createEmptyAccumulator,
  type DailyMetricAccumulator,
  type Database,
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

export function computeBoundsFromIsoTimestamps(
  timestamps: string[],
): { startAt: string; endAt: string } | null {
  if (timestamps.length === 0) return null;

  let minTs = Number.POSITIVE_INFINITY;
  let maxTs = Number.NEGATIVE_INFINITY;
  for (const ts of timestamps) {
    const ms = Date.parse(ts);
    if (Number.isNaN(ms)) continue;
    if (ms < minTs) minTs = ms;
    if (ms > maxTs) maxTs = ms;
  }

  if (!Number.isFinite(minTs) || !Number.isFinite(maxTs)) return null;
  return {
    startAt: new Date(minTs).toISOString(),
    endAt: new Date(maxTs).toISOString(),
  };
}

export async function linkUnassignedHeartRateToWorkouts(
  db: Database,
  userId: string,
  bounds?: { startAt?: string; endAt?: string },
): Promise<number> {
  const filters = [
    sql`ss.user_id = ${userId}`,
    sql`ss.provider_id = ${PROVIDER_ID}`,
    sql`ss.activity_id IS NULL`,
    sql`ss.channel = 'heart_rate'`,
    sql`ss.scalar IS NOT NULL`,
  ];
  if (bounds?.startAt) filters.push(sql`ss.recorded_at >= ${bounds.startAt}::timestamptz`);
  if (bounds?.endAt) filters.push(sql`ss.recorded_at <= ${bounds.endAt}::timestamptz`);

  const linked = await db.execute(
    sql`UPDATE fitness.metric_stream ss
        SET activity_id = (
          SELECT a.id
          FROM fitness.activity a
          WHERE a.user_id = ${userId}
            AND a.provider_id = ${PROVIDER_ID}
            AND ss.recorded_at >= a.started_at
            AND ss.recorded_at <= a.ended_at
          ORDER BY a.started_at DESC
          LIMIT 1
        )
        WHERE ${sql.join(filters, sql` AND `)}
          AND EXISTS (
            SELECT 1
            FROM fitness.activity a
            WHERE a.user_id = ${userId}
              AND a.provider_id = ${PROVIDER_ID}
              AND ss.recorded_at >= a.started_at
              AND ss.recorded_at <= a.ended_at
          )
        RETURNING ss.recorded_at`,
  );

  return Array.isArray(linked) ? linked.length : 0;
}

/** Process body measurement samples */
export async function processBodyMeasurements(
  db: Database,
  userId: string,
  samples: HealthKitSample[],
): Promise<number> {
  let inserted = 0;
  for (let i = 0; i < samples.length; i += BATCH_SIZE) {
    const batch = samples.slice(i, i + BATCH_SIZE);
    for (const sample of batch) {
      const mapping = bodyMeasurementTypes[sample.type];
      if (!mapping) continue;
      const value = mapping.transform ? mapping.transform(sample.value) : sample.value;
      const externalId = `hk:${sample.uuid}`;

      await db.execute(
        sql`INSERT INTO fitness.body_measurement (user_id, provider_id, external_id, recorded_at, ${sql.identifier(mapping.column)})
            VALUES (${userId}, ${PROVIDER_ID}, ${externalId}, ${sample.startDate}::timestamptz, ${value})
            ON CONFLICT (user_id, provider_id, external_id) DO UPDATE
              SET ${sql.identifier(mapping.column)} = ${value}`,
      );
      inserted++;
    }
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
      const key = columnToAccumulatorKey[additiveMapping.column];
      if (key) {
        (accumulator[key] as number) += value;
      }
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

    const key = columnToAccumulatorKey[pointMapping.column];
    if (key) {
      (accumulator[key] as number | null) = sample.value;
    }
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
    const additiveFields: Array<{ column: string; key: keyof DailyMetricAccumulator }> = [
      { column: "steps", key: "steps" },
      { column: "active_energy_kcal", key: "activeEnergyKcal" },
      { column: "basal_energy_kcal", key: "basalEnergyKcal" },
      { column: "distance_km", key: "distanceKm" },
      { column: "cycling_distance_km", key: "cyclingDistanceKm" },
      { column: "flights_climbed", key: "flightsClimbed" },
      { column: "exercise_minutes", key: "exerciseMinutes" },
    ];

    for (const { column, key } of additiveFields) {
      const raw = Number(accumulator[key]);
      if (raw > 0) {
        // Integer columns (steps, flights_climbed, exercise_minutes) need rounding;
        // real columns (active_energy_kcal, basal_energy_kcal, distance_km, cycling_distance_km) don't.
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
): Promise<number> {
  let inserted = 0;
  for (let i = 0; i < samples.length; i += BATCH_SIZE) {
    const batch = samples.slice(i, i + BATCH_SIZE);
    for (const sample of batch) {
      const mapping = metricStreamTypes[sample.type];
      if (!mapping) continue;

      const metricValue = INTEGER_METRIC_STREAM_COLUMNS.has(mapping.column)
        ? Math.round(sample.value)
        : sample.value;
      await db.execute(
        sql`INSERT INTO fitness.metric_stream (recorded_at, user_id, provider_id, device_id, source_type, channel, scalar)
            VALUES (
              ${sample.startDate}::timestamptz,
              ${userId},
              ${PROVIDER_ID},
              ${sample.sourceName ?? null},
              ${"api"},
              ${mapping.column},
              ${metricValue}::real
            )`,
      );
      inserted++;
    }
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

/** Process workout samples */
export async function processWorkouts(
  db: Database,
  userId: string,
  workouts: WorkoutSample[],
): Promise<number> {
  let inserted = 0;
  for (let i = 0; i < workouts.length; i += BATCH_SIZE) {
    const batch = workouts.slice(i, i + BATCH_SIZE);
    for (const workout of batch) {
      const externalId = `hk:workout:${workout.uuid}`;
      const activityType = workoutActivityTypeMap[workout.workoutType] ?? "other";

      const rawData = JSON.stringify({
        duration: workout.duration,
        totalEnergyBurned: workout.totalEnergyBurned,
        totalDistance: workout.totalDistance,
        sourceName: workout.sourceName,
        workoutType: workout.workoutType,
        metadata: workout.metadata,
        workoutActivities: workout.workoutActivities,
      });

      await db.execute(
        sql`INSERT INTO fitness.activity (user_id, provider_id, external_id, activity_type, started_at, ended_at, raw)
            VALUES (
              ${userId},
              ${PROVIDER_ID},
              ${externalId},
              ${activityType},
              ${workout.startDate}::timestamptz,
              ${workout.endDate}::timestamptz,
              ${rawData}::jsonb
            )
            ON CONFLICT (user_id, provider_id, external_id) DO UPDATE SET
              activity_type = ${activityType},
              started_at = ${workout.startDate}::timestamptz,
              ended_at = ${workout.endDate}::timestamptz,
              raw = ${rawData}::jsonb`,
      );
      inserted++;
    }
  }

  if (workouts.length > 0) {
    const bounds = computeBoundsFromIsoTimestamps(
      workouts.flatMap((w) => [w.startDate, w.endDate]),
    );
    await linkUnassignedHeartRateToWorkouts(db, userId, bounds ?? undefined);
  }

  return inserted;
}

/** Process workout route locations — insert GPS data as metric_stream rows */
export async function processWorkoutRoutes(
  db: Database,
  userId: string,
  routes: WorkoutRoute[],
): Promise<number> {
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

    // Batch metric_stream inserts to reduce DB round-trips
    const pendingValues: ReturnType<typeof sql>[] = [];
    const flushPendingValues = async () => {
      if (pendingValues.length === 0) return;
      await db.execute(
        sql`INSERT INTO fitness.metric_stream
              (recorded_at, user_id, provider_id, activity_id, device_id, source_type, channel, scalar)
            VALUES ${sql.join(pendingValues, sql`, `)}`,
      );
      inserted += pendingValues.length;
      pendingValues.length = 0;
    };

    for (const location of route.locations) {
      for (const { channel, getValue, round } of ROUTE_CHANNELS) {
        const value = getValue(location);
        if (value == null) continue;

        const scalar = round ? Math.round(value) : value;
        pendingValues.push(
          sql`(
            ${location.date}::timestamptz,
            ${userId},
            ${PROVIDER_ID},
            ${activityId}::uuid,
            ${route.sourceName ?? null},
            ${"api"},
            ${channel},
            ${scalar}::real
          )`,
        );

        if (pendingValues.length >= BATCH_SIZE) {
          await flushPendingValues();
        }
      }
    }

    await flushPendingValues();
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
  bounds: { startAt: string; endAt: string },
  timezone: string,
): Promise<void> {
  await db.execute(
    sql`INSERT INTO fitness.daily_metrics (date, provider_id, user_id, source_name, spo2_avg)
        SELECT
          (recorded_at AT TIME ZONE ${timezone})::date AS date,
          provider_id,
          user_id,
          device_id AS source_name,
          AVG(scalar) * 100 AS spo2_avg
        FROM fitness.metric_stream
        WHERE provider_id = ${PROVIDER_ID}
          AND user_id = ${userId}
          AND channel = 'spo2'
          AND recorded_at >= ${bounds.startAt}::timestamptz
          AND recorded_at <= ${bounds.endAt}::timestamptz
        GROUP BY 1, provider_id, user_id, device_id
        ON CONFLICT (user_id, date, provider_id, source_name) DO UPDATE SET
          spo2_avg = EXCLUDED.spo2_avg`,
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
  bounds: { startAt: string; endAt: string },
  timezone: string,
): Promise<void> {
  await db.execute(
    sql`INSERT INTO fitness.daily_metrics (date, provider_id, user_id, source_name, skin_temp_c)
        SELECT
          (recorded_at AT TIME ZONE ${timezone})::date AS date,
          provider_id,
          user_id,
          device_id AS source_name,
          AVG(scalar) AS skin_temp_c
        FROM fitness.metric_stream
        WHERE provider_id = ${PROVIDER_ID}
          AND user_id = ${userId}
          AND channel = 'skin_temperature'
          AND recorded_at >= ${bounds.startAt}::timestamptz
          AND recorded_at <= ${bounds.endAt}::timestamptz
        GROUP BY 1, provider_id, user_id, device_id
        ON CONFLICT (user_id, date, provider_id, source_name) DO UPDATE SET
          skin_temp_c = EXCLUDED.skin_temp_c`,
  );
}
