import { sql } from "drizzle-orm";
import { z } from "zod";
import {
  fetchRestingHeartRateRowsFromClickHouse,
  restingHeartRateValuesCte,
} from "../db/resting-heart-rate-query.ts";
import type { Database } from "../db/typed-sql.ts";
import { captureException } from "../lib/error-reporting.ts";
import { logger } from "../logger.ts";

/**
 * Subset of ActivitySensorStore that refit needs. Defined as a structural
 * type here to avoid pulling the server package into src/personalization.
 * Compatible with ActivitySensorStore.query (which accepts a Zod schema).
 */
export interface RefitSensorStore {
  query<TSchema extends z.ZodType>(
    schema: TSchema,
    sql: string,
    params?: Record<string, unknown>,
  ): Promise<z.infer<TSchema>[]>;
}

import type { ExponentialMovingAverageInput } from "./fit-ewma.ts";
import { fitExponentialMovingAverage } from "./fit-ewma.ts";
import type { StressThresholdsInput } from "./fit-stress-thresholds.ts";
import { fitStressThresholds } from "./fit-stress-thresholds.ts";
import type { PersonalizedParams } from "./params.ts";
import { loadPersonalizedParams, savePersonalizedParams } from "./storage.ts";

/**
 * Refit all personalized parameters for a user from their historical data.
 * Each fitter runs independently — one failure doesn't block others.
 * Saves the result to user_settings and returns it.
 *
 * Activity-load and resting-heart-rate fitters read from ClickHouse via
 * `sensorStore`. Other fitters read Postgres directly via `db`.
 */
export async function refitAllParams(
  db: Database,
  userId: string,
  sensorStore: RefitSensorStore,
): Promise<PersonalizedParams> {
  const [ewmaResult, stressResult] = await Promise.allSettled([
    fitEwmaFromDb(sensorStore, userId),
    fitStressFromDb(db, sensorStore, userId),
  ]);

  let existingParams: PersonalizedParams | null = null;
  try {
    existingParams = await loadPersonalizedParams(db, userId);
  } catch (err) {
    logger.error(`[personalization] Failed to load existing params: ${err}`);
    captureException(err, { tags: { context: "personalization-load-existing" } });
  }
  const fittedAt = new Date().toISOString();
  const params: PersonalizedParams = {
    version: 2,
    fittedAt,
    successfulFitAt: {
      exponentialMovingAverage:
        ewmaResult.status === "fulfilled" && ewmaResult.value != null
          ? fittedAt
          : (existingParams?.successfulFitAt?.exponentialMovingAverage ?? null),
      stressThresholds:
        stressResult.status === "fulfilled" && stressResult.value != null
          ? fittedAt
          : (existingParams?.successfulFitAt?.stressThresholds ?? null),
    },
    exponentialMovingAverage:
      ewmaResult.status === "fulfilled" && ewmaResult.value != null
        ? ewmaResult.value
        : (existingParams?.exponentialMovingAverage ?? null),
    stressThresholds:
      stressResult.status === "fulfilled" && stressResult.value != null
        ? stressResult.value
        : (existingParams?.stressThresholds ?? null),
  };

  try {
    await savePersonalizedParams(db, userId, params);
  } catch (err) {
    logger.error(`[personalization] Failed to save params: ${err}`);
    captureException(err, { tags: { context: "personalization-save" } });
  }

  return params;
}

// --- Exported Zod schemas and row-parsing functions for testability ---

export const exponentialMovingAverageRowSchema = z.object({
  date: z.string(),
  daily_load: z.coerce.number(),
  avg_performance: z.coerce.number(),
});

/** Parse raw EWMA query rows into fitter input, filtering invalid/zero-performance rows. */
export function parseExponentialMovingAverageRows(
  rows: Record<string, unknown>[],
): ExponentialMovingAverageInput[] {
  const data: ExponentialMovingAverageInput[] = [];
  for (const row of rows) {
    const parsed = exponentialMovingAverageRowSchema.safeParse(row);
    if (!parsed.success) continue;
    if (parsed.data.avg_performance === 0) continue;
    data.push({
      date: parsed.data.date,
      load: parsed.data.daily_load,
      performance: parsed.data.avg_performance,
    });
  }
  return data;
}

async function fitEwmaFromDb(sensorStore: RefitSensorStore, userId: string) {
  // Reads from analytics.activity_summary (CH); the dropped Postgres
  // materialized view is no longer available.
  const rows = await sensorStore.query(
    exponentialMovingAverageRowSchema,
    `WITH daily_load AS (
      SELECT
        toDate(asum.started_at) AS date,
        sum(
          dateDiff('second', asum.started_at, asum.ended_at) / 60.0
          * asum.avg_hr / nullIf(toFloat64(asum.max_hr), 0)
        ) AS daily_load
      FROM analytics.activity_summary asum
      WHERE asum.user_id = {userId:UUID}
        AND asum.started_at > now() - INTERVAL 365 DAY
        AND asum.ended_at IS NOT NULL
        AND asum.avg_hr IS NOT NULL
      GROUP BY toDate(asum.started_at)
    ),
    daily_perf AS (
      SELECT
        toDate(asum.started_at) AS date,
        avg(if(asum.avg_power > 0, asum.avg_power, asum.avg_hr)) AS avg_performance
      FROM analytics.activity_summary asum
      WHERE asum.user_id = {userId:UUID}
        AND asum.started_at > now() - INTERVAL 365 DAY
        AND asum.ended_at IS NOT NULL
      GROUP BY toDate(asum.started_at)
    ),
    date_series AS (
      SELECT today() - 365 + INTERVAL number DAY AS date
      FROM numbers(366)
    )
    SELECT
      toString(ds.date) AS date,
      coalesce(dl.daily_load, 0) AS daily_load,
      coalesce(dp.avg_performance, 0) AS avg_performance
    FROM date_series ds
    LEFT JOIN daily_load dl ON dl.date = ds.date
    LEFT JOIN daily_perf dp ON dp.date = ds.date
    ORDER BY ds.date ASC`,
    { userId },
  );

  return fitExponentialMovingAverage(parseExponentialMovingAverageRows(rows));
}

export const stressRowSchema = z.object({
  hrv_z: z.coerce.number(),
  rhr_z: z.coerce.number(),
});

/** Parse raw stress query rows into fitter input. */
export function parseStressRows(rows: Record<string, unknown>[]): StressThresholdsInput[] {
  const data: StressThresholdsInput[] = [];
  for (const row of rows) {
    const parsed = stressRowSchema.safeParse(row);
    if (!parsed.success) continue;
    data.push({ hrvZScore: parsed.data.hrv_z, rhrZScore: parsed.data.rhr_z });
  }
  return data;
}

async function fitStressFromDb(db: Database, sensorStore: RefitSensorStore, userId: string) {
  const restingHeartRateCte = restingHeartRateValuesCte(
    await fetchRestingHeartRateRowsFromClickHouse({
      queryStore: sensorStore,
      userId,
      timezone: "UTC",
      endDate: currentUtcDateString(),
      days: 425,
    }),
  );
  const rows = await db.execute(
    sql`WITH ${restingHeartRateCte},
        metrics AS (
          SELECT
            dm.date,
            dm.hrv,
            drhr.resting_hr
          FROM fitness.v_daily_metrics dm
          JOIN resting_heart_rate drhr
            ON drhr.date = dm.date
          WHERE dm.user_id = ${userId}
            AND dm.date > CURRENT_DATE - 425
            AND dm.hrv IS NOT NULL
        )
        SELECT
          (hrv - AVG(hrv) OVER (ORDER BY date ROWS BETWEEN 59 PRECEDING AND CURRENT ROW))
            / NULLIF(STDDEV_POP(hrv) OVER (ORDER BY date ROWS BETWEEN 59 PRECEDING AND CURRENT ROW), 0) AS hrv_z,
          (resting_hr - AVG(resting_hr) OVER (ORDER BY date ROWS BETWEEN 59 PRECEDING AND CURRENT ROW))
            / NULLIF(STDDEV_POP(resting_hr) OVER (ORDER BY date ROWS BETWEEN 59 PRECEDING AND CURRENT ROW), 0) AS rhr_z
        FROM metrics
        ORDER BY date ASC`,
  );

  return fitStressThresholds(parseStressRows(rows));
}

function currentUtcDateString(): string {
  return new Date().toISOString().slice(0, 10);
}
