import { zScoreToRecoveryScore } from "@dofek/scoring/scoring";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/typed-sql.ts";
import { logger } from "../logger.ts";
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
import { savePersonalizedParams } from "./storage.ts";

/**
 * Refit all personalized parameters for a user from their historical data.
 * Each fitter runs independently — one failure doesn't block others.
 * Saves the result to user_settings and returns it.
 */
export async function refitAllParams(db: Database, userId: string): Promise<PersonalizedParams> {
  const [ewmaResult, readinessResult, sleepResult, stressResult, trimpResult] =
    await Promise.allSettled([
      fitEwmaFromDb(db, userId),
      fitReadinessFromDb(db, userId),
      fitSleepFromDb(db, userId),
      fitStressFromDb(db, userId),
      fitTrimpFromDb(db, userId),
    ]);

  const params: PersonalizedParams = {
    version: 1,
    fittedAt: new Date().toISOString(),
    exponentialMovingAverage: ewmaResult.status === "fulfilled" ? ewmaResult.value : null,
    readinessWeights: readinessResult.status === "fulfilled" ? readinessResult.value : null,
    sleepTarget: sleepResult.status === "fulfilled" ? sleepResult.value : null,
    stressThresholds: stressResult.status === "fulfilled" ? stressResult.value : null,
    trainingImpulseConstants: trimpResult.status === "fulfilled" ? trimpResult.value : null,
  };

  try {
    await savePersonalizedParams(db, userId, params);
  } catch (err) {
    logger.error(`[personalization] Failed to save params: ${err}`);
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

async function fitEwmaFromDb(db: Database, userId: string) {
  const rows = await db.execute(
    sql`WITH daily_load AS (
          SELECT
            asum.started_at::date AS date,
            SUM(
              EXTRACT(EPOCH FROM (asum.ended_at - asum.started_at)) / 60.0
              * asum.avg_hr / NULLIF(asum.max_hr, 0)
            ) AS daily_load
          FROM fitness.activity_summary asum
          WHERE asum.user_id = ${userId}
            AND asum.started_at > NOW() - INTERVAL '365 days'
            AND asum.ended_at IS NOT NULL
            AND asum.avg_hr IS NOT NULL
          GROUP BY asum.started_at::date
        ),
        daily_perf AS (
          SELECT
            asum.started_at::date AS date,
            AVG(
              CASE
                WHEN asum.avg_power > 0 THEN asum.avg_power
                ELSE asum.avg_hr
              END
            ) AS avg_performance
          FROM fitness.activity_summary asum
          WHERE asum.user_id = ${userId}
            AND asum.started_at > NOW() - INTERVAL '365 days'
            AND asum.ended_at IS NOT NULL
          GROUP BY asum.started_at::date
        )
        SELECT
          ds.date::text AS date,
          COALESCE(dl.daily_load, 0) AS daily_load,
          COALESCE(dp.avg_performance, 0) AS avg_performance
        FROM generate_series(
          CURRENT_DATE - 365,
          CURRENT_DATE,
          '1 day'::interval
        ) AS ds(date)
        LEFT JOIN daily_load dl ON dl.date = ds.date
        LEFT JOIN daily_perf dp ON dp.date = ds.date
        ORDER BY ds.date ASC`,
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
    const p = parsed.data;

    if (
      p.hrv == null ||
      p.hrv_mean == null ||
      p.hrv_sd == null ||
      Number(p.hrv_sd) === 0 ||
      p.resting_hr == null ||
      p.rhr_mean == null ||
      p.rhr_sd == null ||
      Number(p.rhr_sd) === 0 ||
      p.next_day_hrv == null ||
      p.next_day_hrv_mean == null ||
      p.next_day_hrv_sd == null ||
      Number(p.next_day_hrv_sd) === 0
    )
      continue;

    const zHrv = (Number(p.hrv) - Number(p.hrv_mean)) / Number(p.hrv_sd);
    const zRhr = (Number(p.resting_hr) - Number(p.rhr_mean)) / Number(p.rhr_sd);
    const hrvScore = zScoreToRecoveryScore(zHrv);
    const rhrScore = zScoreToRecoveryScore(-zRhr);
    const sleepScore =
      p.efficiency_pct != null ? Math.max(0, Math.min(100, Number(p.efficiency_pct))) : 62;

    // Respiratory rate score: lower is better (like RHR), inverted z-score
    let respiratoryRateScore = 62;
    if (p.respiratory_rate != null && p.rr_mean != null && p.rr_sd != null && Number(p.rr_sd) > 0) {
      const zRr = (Number(p.respiratory_rate) - Number(p.rr_mean)) / Number(p.rr_sd);
      respiratoryRateScore = zScoreToRecoveryScore(-zRr);
    }

    const nextDayHrvZScore =
      (Number(p.next_day_hrv) - Number(p.next_day_hrv_mean)) / Number(p.next_day_hrv_sd);

    data.push({ hrvScore, rhrScore: rhrScore, sleepScore, respiratoryRateScore, nextDayHrvZScore });
  }
  return data;
}

async function fitReadinessFromDb(db: Database, userId: string) {
  const rows = await db.execute(
    sql`WITH metrics_base AS (
          SELECT
            date,
            hrv,
            resting_hr,
            respiratory_rate_avg AS respiratory_rate,
            AVG(hrv) OVER (ORDER BY date ROWS BETWEEN 29 PRECEDING AND CURRENT ROW) AS hrv_mean,
            STDDEV_POP(hrv) OVER (ORDER BY date ROWS BETWEEN 29 PRECEDING AND CURRENT ROW) AS hrv_sd,
            AVG(resting_hr) OVER (ORDER BY date ROWS BETWEEN 29 PRECEDING AND CURRENT ROW) AS rhr_mean,
            STDDEV_POP(resting_hr) OVER (ORDER BY date ROWS BETWEEN 29 PRECEDING AND CURRENT ROW) AS rhr_sd,
            AVG(respiratory_rate_avg) OVER (ORDER BY date ROWS BETWEEN 29 PRECEDING AND CURRENT ROW) AS rr_mean,
            STDDEV_POP(respiratory_rate_avg) OVER (ORDER BY date ROWS BETWEEN 29 PRECEDING AND CURRENT ROW) AS rr_sd
          FROM fitness.v_daily_metrics
          WHERE user_id = ${userId}
            AND date > CURRENT_DATE - 425
        ),
        metrics AS (
          SELECT
            *,
            LEAD(hrv) OVER (ORDER BY date) AS next_day_hrv,
            LEAD(hrv_mean) OVER (ORDER BY date) AS next_day_hrv_mean,
            LEAD(hrv_sd) OVER (ORDER BY date) AS next_day_hrv_sd
          FROM metrics_base
        ),
        sleep_eff AS (
          SELECT DISTINCT ON (COALESCE(ended_at, started_at + interval '8 hours')::date)
            COALESCE(ended_at, started_at + interval '8 hours')::date AS date,
            efficiency_pct
          FROM fitness.v_sleep
          WHERE user_id = ${userId}
            AND is_nap = false
            AND started_at > NOW() - INTERVAL '425 days'
          ORDER BY COALESCE(ended_at, started_at + interval '8 hours')::date, started_at DESC
        )
        SELECT
          m.hrv, m.resting_hr, m.hrv_mean, m.hrv_sd, m.rhr_mean, m.rhr_sd,
          m.respiratory_rate, m.rr_mean, m.rr_sd,
          s.efficiency_pct,
          m.next_day_hrv, m.next_day_hrv_mean, m.next_day_hrv_sd
        FROM metrics m
        LEFT JOIN sleep_eff s ON s.date = m.date
        WHERE m.date > CURRENT_DATE - 365
        ORDER BY m.date ASC`,
  );

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

async function fitSleepFromDb(db: Database, userId: string) {
  const rows = await db.execute(
    sql`WITH nightly AS (
          SELECT
            COALESCE(s.ended_at, s.started_at + interval '8 hours')::date AS date,
            s.duration_minutes
          FROM fitness.v_sleep s
          WHERE s.user_id = ${userId}
            AND s.is_nap = false
            AND s.started_at > NOW() - INTERVAL '365 days'
        ),
        hrv_with_median AS (
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
          n.duration_minutes,
          CASE WHEN h.hrv >= h.median_hrv THEN true ELSE false END AS hrv_above_median
        FROM nightly n
        JOIN hrv_with_median h ON h.date = n.date + 1
        ORDER BY n.date ASC`,
  );

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

async function fitStressFromDb(db: Database, userId: string) {
  const rows = await db.execute(
    sql`SELECT
          (hrv - AVG(hrv) OVER (ORDER BY date ROWS BETWEEN 59 PRECEDING AND CURRENT ROW))
            / NULLIF(STDDEV_POP(hrv) OVER (ORDER BY date ROWS BETWEEN 59 PRECEDING AND CURRENT ROW), 0) AS hrv_z,
          (resting_hr - AVG(resting_hr) OVER (ORDER BY date ROWS BETWEEN 59 PRECEDING AND CURRENT ROW))
            / NULLIF(STDDEV_POP(resting_hr) OVER (ORDER BY date ROWS BETWEEN 59 PRECEDING AND CURRENT ROW), 0) AS rhr_z
        FROM fitness.v_daily_metrics
        WHERE user_id = ${userId}
          AND date > CURRENT_DATE - 425
          AND hrv IS NOT NULL
          AND resting_hr IS NOT NULL
        ORDER BY date ASC`,
  );

  return fitStressThresholds(parseStressRows(rows));
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
    const p = parsed.data;
    if (p.duration_min <= 0 || p.max_hr <= p.resting_hr || p.power_tss <= 0) continue;
    data.push({
      durationMin: p.duration_min,
      avgHr: p.avg_hr,
      maxHr: p.max_hr,
      restingHr: p.resting_hr,
      powerTss: p.power_tss,
    });
  }
  return data;
}

async function fitTrimpFromDb(db: Database, userId: string) {
  const rows = await db.execute(
    sql`WITH rolling_power AS (
          SELECT
            ms.activity_id,
            AVG(ms.power) OVER (
              PARTITION BY ms.activity_id
              ORDER BY ms.recorded_at
              RANGE BETWEEN INTERVAL '29 seconds' PRECEDING AND CURRENT ROW
            ) AS rolling_30s_power
          FROM fitness.metric_stream ms
          JOIN fitness.v_activity a ON a.id = ms.activity_id
          WHERE a.user_id = ${userId}
            AND a.started_at > NOW() - INTERVAL '365 days'
            AND ms.power > 0
        ),
        np_data AS (
          SELECT
            activity_id,
            ROUND(POWER(AVG(POWER(rolling_30s_power, 4)), 0.25)::numeric, 1) AS np
          FROM rolling_power
          GROUP BY activity_id
          HAVING COUNT(*) >= 60
        )
        SELECT
          EXTRACT(EPOCH FROM (asum.ended_at - asum.started_at)) / 60 AS duration_min,
          asum.avg_hr,
          GREATEST(asum.max_hr, up.max_hr) AS max_hr,
          COALESCE(up.resting_hr, 60) AS resting_hr,
          POWER(n.np / NULLIF(
            (SELECT MAX(n2.np) * 0.95 FROM np_data n2
             JOIN fitness.activity_summary a2 ON a2.activity_id = n2.activity_id
             WHERE EXTRACT(EPOCH FROM (a2.ended_at - a2.started_at)) / 60 >= 20),
          0), 2) * (EXTRACT(EPOCH FROM (asum.ended_at - asum.started_at)) / 3600.0) * 100 AS power_tss
        FROM fitness.activity_summary asum
        JOIN fitness.user_profile up ON up.id = asum.user_id
        JOIN np_data n ON n.activity_id = asum.activity_id
        WHERE asum.user_id = ${userId}
          AND asum.hr_sample_count > 0
          AND asum.avg_hr > 0`,
  );

  return fitTrainingImpulseConstants(parseTrainingImpulseRows(rows));
}
