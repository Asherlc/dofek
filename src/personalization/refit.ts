import { zScoreToRecoveryScore } from "@dofek/scoring/scoring";
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
import type { ReadinessWeightsInput } from "./fit-readiness-weights.ts";
import { fitReadinessWeights } from "./fit-readiness-weights.ts";
import type { SleepTargetInput } from "./fit-sleep-target.ts";
import { fitSleepTarget } from "./fit-sleep-target.ts";
import type { StressThresholdsInput } from "./fit-stress-thresholds.ts";
import { fitStressThresholds } from "./fit-stress-thresholds.ts";
import type { TrainingImpulseInput } from "./fit-trimp.ts";
import { fitTrainingImpulseConstants } from "./fit-trimp.ts";
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
  const [ewmaResult, readinessResult, sleepResult, stressResult, trimpResult] =
    await Promise.allSettled([
      fitEwmaFromDb(sensorStore, userId),
      fitReadinessFromDb(db, sensorStore, userId),
      fitSleepFromDb(db, sensorStore, userId),
      fitStressFromDb(db, sensorStore, userId),
      fitTrimpFromDb(sensorStore, userId),
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
      readinessWeights:
        readinessResult.status === "fulfilled" && readinessResult.value != null
          ? fittedAt
          : (existingParams?.successfulFitAt?.readinessWeights ?? null),
      sleepTarget:
        sleepResult.status === "fulfilled" && sleepResult.value != null
          ? fittedAt
          : (existingParams?.successfulFitAt?.sleepTarget ?? null),
      stressThresholds:
        stressResult.status === "fulfilled" && stressResult.value != null
          ? fittedAt
          : (existingParams?.successfulFitAt?.stressThresholds ?? null),
      trainingImpulseConstants:
        trimpResult.status === "fulfilled" && trimpResult.value != null
          ? fittedAt
          : (existingParams?.successfulFitAt?.trainingImpulseConstants ?? null),
    },
    exponentialMovingAverage:
      ewmaResult.status === "fulfilled" && ewmaResult.value != null
        ? ewmaResult.value
        : (existingParams?.exponentialMovingAverage ?? null),
    readinessWeights:
      readinessResult.status === "fulfilled" && readinessResult.value != null
        ? readinessResult.value
        : (existingParams?.readinessWeights ?? null),
    sleepTarget:
      sleepResult.status === "fulfilled" && sleepResult.value != null
        ? sleepResult.value
        : (existingParams?.sleepTarget ?? null),
    stressThresholds:
      stressResult.status === "fulfilled" && stressResult.value != null
        ? stressResult.value
        : (existingParams?.stressThresholds ?? null),
    trainingImpulseConstants:
      trimpResult.status === "fulfilled" && trimpResult.value != null
        ? trimpResult.value
        : (existingParams?.trainingImpulseConstants ?? null),
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

export const readinessRowSchema = z.object({
  hrv: z.coerce.number().nullable(),
  resting_hr: z.coerce.number().nullable(),
  hrv_mean: z.coerce.number().nullable(),
  hrv_sd: z.coerce.number().nullable(),
  rhr_mean: z.coerce.number().nullable(),
  rhr_sd: z.coerce.number().nullable(),
  efficiency_pct: z.coerce.number().nullable(),
  respiratory_rate: z.coerce.number().nullable(),
  rr_mean: z.coerce.number().nullable(),
  rr_sd: z.coerce.number().nullable(),
  next_day_hrv: z.coerce.number().nullable(),
  next_day_hrv_mean: z.coerce.number().nullable(),
  next_day_hrv_sd: z.coerce.number().nullable(),
});

/** Parse raw readiness query rows into fitter input, computing z-scores and component scores. */
export function parseReadinessRows(rows: Record<string, unknown>[]): ReadinessWeightsInput[] {
  const data: ReadinessWeightsInput[] = [];
  for (const row of rows) {
    const parsed = readinessRowSchema.safeParse(row);
    if (!parsed.success) continue;
    const parsedRow = parsed.data;

    if (
      parsedRow.hrv == null ||
      parsedRow.hrv_mean == null ||
      parsedRow.hrv_sd == null ||
      Number(parsedRow.hrv_sd) === 0 ||
      parsedRow.resting_hr == null ||
      parsedRow.rhr_mean == null ||
      parsedRow.rhr_sd == null ||
      Number(parsedRow.rhr_sd) === 0 ||
      parsedRow.next_day_hrv == null ||
      parsedRow.next_day_hrv_mean == null ||
      parsedRow.next_day_hrv_sd == null ||
      Number(parsedRow.next_day_hrv_sd) === 0
    )
      continue;

    const zHrv = (Number(parsedRow.hrv) - Number(parsedRow.hrv_mean)) / Number(parsedRow.hrv_sd);
    const zRhr =
      (Number(parsedRow.resting_hr) - Number(parsedRow.rhr_mean)) / Number(parsedRow.rhr_sd);
    const hrvScore = zScoreToRecoveryScore(zHrv);
    const rhrScore = zScoreToRecoveryScore(-zRhr);
    const sleepScore =
      parsedRow.efficiency_pct != null
        ? Math.max(0, Math.min(100, Number(parsedRow.efficiency_pct)))
        : 62;

    // Respiratory rate score: lower is better (like RHR), inverted z-score
    let respiratoryRateScore = 62;
    if (
      parsedRow.respiratory_rate != null &&
      parsedRow.rr_mean != null &&
      parsedRow.rr_sd != null &&
      Number(parsedRow.rr_sd) > 0
    ) {
      const zRr =
        (Number(parsedRow.respiratory_rate) - Number(parsedRow.rr_mean)) / Number(parsedRow.rr_sd);
      respiratoryRateScore = zScoreToRecoveryScore(-zRr);
    }

    const nextDayHrvZScore =
      (Number(parsedRow.next_day_hrv) - Number(parsedRow.next_day_hrv_mean)) /
      Number(parsedRow.next_day_hrv_sd);

    data.push({ hrvScore, rhrScore: rhrScore, sleepScore, respiratoryRateScore, nextDayHrvZScore });
  }
  return data;
}

async function fitReadinessFromDb(db: Database, sensorStore: RefitSensorStore, userId: string) {
  const restingHeartRateCte = restingHeartRateValuesCte(
    await fetchRestingHeartRateRowsFromClickHouse({
      queryStore: sensorStore,
      userId,
      timezone: "UTC",
      endDate: currentUtcDateString(),
      days: 425,
    }),
  );
  const [metricRows, sleepRows] = await Promise.all([
    db.execute(
      sql`WITH ${restingHeartRateCte},
        metrics_base AS (
          SELECT
            dm.date,
            dm.hrv,
            drhr.resting_hr,
            dm.respiratory_rate_avg AS respiratory_rate,
            AVG(dm.hrv) OVER (ORDER BY dm.date ROWS BETWEEN 29 PRECEDING AND CURRENT ROW) AS hrv_mean,
            STDDEV_POP(dm.hrv) OVER (ORDER BY dm.date ROWS BETWEEN 29 PRECEDING AND CURRENT ROW) AS hrv_sd,
            AVG(drhr.resting_hr) OVER (ORDER BY dm.date ROWS BETWEEN 29 PRECEDING AND CURRENT ROW) AS rhr_mean,
            STDDEV_POP(drhr.resting_hr) OVER (ORDER BY dm.date ROWS BETWEEN 29 PRECEDING AND CURRENT ROW) AS rhr_sd,
            AVG(dm.respiratory_rate_avg) OVER (ORDER BY dm.date ROWS BETWEEN 29 PRECEDING AND CURRENT ROW) AS rr_mean,
            STDDEV_POP(dm.respiratory_rate_avg) OVER (ORDER BY dm.date ROWS BETWEEN 29 PRECEDING AND CURRENT ROW) AS rr_sd
          FROM fitness.v_daily_metrics dm
          LEFT JOIN resting_heart_rate drhr
            ON drhr.date = dm.date
          WHERE dm.user_id = ${userId}
            AND dm.date > CURRENT_DATE - 425
        ),
        metrics AS (
          SELECT
            *,
            LEAD(hrv) OVER (ORDER BY date) AS next_day_hrv,
            LEAD(hrv_mean) OVER (ORDER BY date) AS next_day_hrv_mean,
            LEAD(hrv_sd) OVER (ORDER BY date) AS next_day_hrv_sd
          FROM metrics_base
        )
        SELECT
          m.hrv, m.resting_hr, m.hrv_mean, m.hrv_sd, m.rhr_mean, m.rhr_sd,
          m.respiratory_rate, m.rr_mean, m.rr_sd,
          m.date,
          NULL::real AS efficiency_pct,
          m.next_day_hrv, m.next_day_hrv_mean, m.next_day_hrv_sd
        FROM metrics m
        WHERE m.date > CURRENT_DATE - 365
        ORDER BY m.date ASC`,
    ),
    sensorStore.query(
      z.object({
        date: z.string(),
        efficiency_pct: z.coerce.number().nullable(),
      }),
      `SELECT
        toString(sleep.date) AS date,
        sleep.efficiency_pct AS efficiency_pct
      FROM analytics.daily_sleep AS sleep FINAL
      WHERE sleep.user_id = {userId:UUID}
        AND sleep.is_deleted = 0
        AND sleep.date >= toDate(now() - INTERVAL 425 DAY)`,
      { userId },
    ),
  ]);
  const sleepEfficiencyByDate = new Map(sleepRows.map((row) => [row.date, row.efficiency_pct]));
  const rows = metricRows.map((row) => {
    const rowDate = z.object({ date: z.coerce.string() }).parse(row).date;
    return {
      ...row,
      efficiency_pct: sleepEfficiencyByDate.get(rowDate) ?? null,
    };
  });

  return fitReadinessWeights(parseReadinessRows(rows));
}

export const sleepRowSchema = z.object({
  duration_minutes: z.coerce.number(),
  hrv_above_median: z.coerce.boolean(),
});

/** Parse raw sleep query rows into fitter input. */
export function parseSleepRows(rows: Record<string, unknown>[]): SleepTargetInput[] {
  const data: SleepTargetInput[] = [];
  for (const row of rows) {
    const parsed = sleepRowSchema.safeParse(row);
    if (!parsed.success) continue;
    data.push({
      durationMinutes: parsed.data.duration_minutes,
      nextDayHrvAboveMedian: parsed.data.hrv_above_median,
    });
  }
  return data;
}

export async function fitSleepFromDb(
  db: Database,
  userId: string,
): Promise<PersonalizedParams["sleepTarget"]>;
export async function fitSleepFromDb(
  db: Database,
  sensorStore: RefitSensorStore,
  userId: string,
): Promise<PersonalizedParams["sleepTarget"]>;
export async function fitSleepFromDb(
  db: Database,
  sensorStoreOrUserId: RefitSensorStore | string,
  maybeUserId?: string,
): Promise<PersonalizedParams["sleepTarget"]> {
  const userId = typeof sensorStoreOrUserId === "string" ? sensorStoreOrUserId : maybeUserId;
  if (!userId) {
    throw new Error("fitSleepFromDb requires a user id");
  }
  const [sleepRows, hrvRows] = await Promise.all([
    typeof sensorStoreOrUserId === "string"
      ? db.execute(
          sql`WITH nightly AS (
            SELECT DISTINCT ON (date)
              ((started_at AT TIME ZONE 'UTC') - INTERVAL '6 hours')::date::text AS date,
              duration_minutes
            FROM fitness.sleep_session
            WHERE user_id = ${userId}
              AND sleep_type = 'sleep'
              AND started_at > NOW() - INTERVAL '365 days'
            ORDER BY date, duration_minutes DESC NULLS LAST
          )
          SELECT date, duration_minutes FROM nightly ORDER BY date ASC`,
        )
      : sensorStoreOrUserId.query(
          z.object({
            date: z.string(),
            duration_minutes: z.coerce.number().nullable(),
          }),
          `SELECT
        toString(sleep.date) AS date,
        sleep.duration_minutes AS duration_minutes
      FROM analytics.daily_sleep AS sleep FINAL
      WHERE sleep.user_id = {userId:UUID}
        AND sleep.is_deleted = 0
        AND sleep.date >= toDate(now() - INTERVAL 365 DAY)
      ORDER BY date ASC`,
          { userId },
        ),
    db.execute(
      sql`WITH hrv_with_median AS (
          SELECT
            d.date,
            d.hrv,
            m.median_hrv
          FROM fitness.v_daily_metrics d
          CROSS JOIN LATERAL (
            SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY d2.hrv) AS median_hrv
            FROM fitness.v_daily_metrics d2
            WHERE d2.user_id = d.user_id
              AND d2.date BETWEEN d.date - 59 AND d.date
              AND d2.hrv IS NOT NULL
          ) m
          WHERE d.user_id = ${userId}
            AND d.date > CURRENT_DATE - 425
            AND d.hrv IS NOT NULL
        )
        SELECT
          date::text AS date,
          CASE WHEN hrv >= median_hrv THEN true ELSE false END AS hrv_above_median
        FROM hrv_with_median`,
    ),
  ]);
  const hrvByDate = new Map(
    hrvRows.map((row) => {
      const parsed = z
        .object({ date: z.string(), hrv_above_median: z.coerce.boolean() })
        .parse(row);
      return [parsed.date, parsed.hrv_above_median];
    }),
  );
  const rows = sleepRows.flatMap((row) => {
    if (row.duration_minutes == null) return [];
    const date = new Date(`${row.date}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() + 1);
    const nextDate = date.toISOString().slice(0, 10);
    const hrvAboveMedian = hrvByDate.get(nextDate);
    if (hrvAboveMedian == null) return [];
    return [{ duration_minutes: row.duration_minutes, hrv_above_median: hrvAboveMedian }];
  });

  return fitSleepTarget(parseSleepRows(rows));
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

export const trainingImpulseActivityRowSchema = z.object({
  duration_min: z.coerce.number(),
  avg_hr: z.coerce.number(),
  max_hr: z.coerce.number(),
  resting_hr: z.coerce.number(),
  power_tss: z.coerce.number(),
});

/** Parse raw TRIMP query rows into fitter input, filtering invalid rows. */
export function parseTrainingImpulseRows(rows: Record<string, unknown>[]): TrainingImpulseInput[] {
  const data: TrainingImpulseInput[] = [];
  for (const row of rows) {
    const parsed = trainingImpulseActivityRowSchema.safeParse(row);
    if (!parsed.success) continue;
    const parsedRow = parsed.data;
    if (
      parsedRow.duration_min <= 0 ||
      parsedRow.max_hr <= parsedRow.resting_hr ||
      parsedRow.power_tss <= 0
    )
      continue;
    data.push({
      durationMin: parsedRow.duration_min,
      avgHr: parsedRow.avg_hr,
      maxHr: parsedRow.max_hr,
      restingHr: parsedRow.resting_hr,
      powerTss: parsedRow.power_tss,
    });
  }
  return data;
}

async function fitTrimpFromDb(sensorStore: RefitSensorStore, userId: string) {
  // Reads precomputed normalized power and TRIMP inputs from the activity
  // summary read model, joining user_profile for max_hr / resting_hr.
  const rows = await sensorStore.query(
    trainingImpulseActivityRowSchema,
    `WITH ftp_estimate AS (
      SELECT max(normalized_power) * 0.95 AS ftp
      FROM analytics.activity_summary
      WHERE user_id = {userId:UUID}
        AND started_at > now() - INTERVAL 365 DAY
        AND dateDiff('second', started_at, ended_at) / 60 >= 20
        AND normalized_power IS NOT NULL
    )
    SELECT
      dateDiff('second', asum.started_at, asum.ended_at) / 60 AS duration_min,
      asum.avg_hr AS avg_hr,
      greatest(asum.max_hr, up.max_hr) AS max_hr,
      coalesce(up.resting_hr, 60) AS resting_hr,
      pow(asum.normalized_power / nullIf((SELECT ftp FROM ftp_estimate), 0), 2)
        * (dateDiff('second', asum.started_at, asum.ended_at) / 3600.0)
        * 100 AS power_tss
    FROM analytics.activity_summary asum
    INNER JOIN postgres_fitness.user_profile_current up ON up.id = asum.user_id
    WHERE asum.user_id = {userId:UUID}
      AND asum.hr_sample_count > 0
      AND asum.avg_hr > 0
      AND asum.normalized_power IS NOT NULL`,
    { userId },
  );

  return fitTrainingImpulseConstants(parseTrainingImpulseRows(rows));
}
