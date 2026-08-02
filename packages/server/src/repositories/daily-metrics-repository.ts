import { type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import {
  HEALTH_METRIC_EVIDENCE_WINDOW_DAYS,
  healthMetricEvidenceRowsSchema,
} from "../contracts/mobile-dashboard-contracts.ts";
import { BaseRepository } from "../lib/base-repository.ts";
import {
  dateWindowEnd,
  dateWindowStartPredicate,
  dateWindowStartString,
  type RangeDays,
  rangeDaysOrNullAdd,
} from "../lib/date-window.ts";
import { dateStringSchema } from "../lib/typed-sql.ts";
import { restingHeartRateValuesCte } from "./resting-heart-rate-query.ts";

export const HRV_BASELINE_WARMUP_DAYS = 60;

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const dailyMetricsViewRowSchema = z.object({
  date: dateStringSchema,
  user_id: z.string(),
  hrv: z.number().nullable(),
  spo2_avg: z.number().nullable(),
  respiratory_rate_avg: z.number().nullable(),
  skin_temp_c: z.number().nullable(),
  steps: z.number().nullable(),
  distance_km: z.number().nullable(),
  flights_climbed: z.number().nullable(),
  exercise_minutes: z.number().nullable(),
  stand_hours: z.number().nullable(),
  walking_speed: z.number().nullable(),
  source_providers: z.array(z.string()),
});

const healthTrendRowSchema = dailyMetricsViewRowSchema.extend({
  resting_hr: z.coerce.number().nullable(),
});

export type HealthTrendRow = z.infer<typeof healthTrendRowSchema>;

export type DailyMetricsViewRow = z.infer<typeof dailyMetricsViewRowSchema>;

const hrvBaselineRowSchema = z.object({
  date: dateStringSchema,
  hrv: z.coerce.number().nullable(),
  resting_hr: z.coerce.number().nullable(),
  mean_60d: z.coerce.number().nullable(),
  sd_60d: z.coerce.number().nullable(),
  mean_7d: z.coerce.number().nullable(),
  resting_hr_mean_7d: z.coerce.number().nullable(),
});

export type HrvBaselineRow = z.infer<typeof hrvBaselineRowSchema>;

export const trendsRowSchema = z.object({
  avg_hrv: z.coerce.number().nullable(),
  avg_resting_hr: z.coerce.number().nullable(),
  avg_spo2: z.coerce.number().nullable(),
  avg_steps: z.coerce.number().nullable(),
  avg_skin_temp: z.coerce.number().nullable(),
  stddev_hrv: z.coerce.number().nullable(),
  stddev_resting_hr: z.coerce.number().nullable(),
  stddev_spo2: z.coerce.number().nullable(),
  stddev_steps: z.coerce.number().nullable(),
  stddev_skin_temp: z.coerce.number().nullable(),
  latest_hrv: z.coerce.number().nullable(),
  latest_resting_hr: z.coerce.number().nullable(),
  latest_spo2: z.coerce.number().nullable(),
  latest_steps: z.coerce.number().nullable(),
  latest_skin_temp: z.coerce.number().nullable(),
  latest_date: dateStringSchema.nullable(),
  latest_steps_date: dateStringSchema.nullable(),
  metric_evidence: healthMetricEvidenceRowsSchema.nullable().optional(),
});

export type TrendsRow = z.infer<typeof trendsRowSchema>;

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

/** Data access for daily health metrics (vitals, activity, body). */
export class DailyMetricsRepository extends BaseRepository {
  /** Daily metrics within the given date window, ordered by date ascending. */
  async list(days: RangeDays, endDate: string): Promise<DailyMetricsViewRow[]> {
    return this.query(
      dailyMetricsViewRowSchema,
      sql`SELECT
            date,
            user_id,
            hrv,
            spo2_avg,
            respiratory_rate_avg,
            skin_temp_c,
            steps,
            distance_km,
            flights_climbed,
            exercise_minutes,
            stand_hours,
            walking_speed,
            source_providers
          FROM fitness.v_daily_metrics
          WHERE user_id = ${this.userId}
            ${dateWindowStartPredicate(sql`date`, endDate, days)}
            AND date <= ${dateWindowEnd(endDate)}
            ${this.dateAccessPredicate(sql`date`)}
          ORDER BY date ASC`,
    );
  }

  /** Daily health metrics inside an exact inclusive range, including resting heart rate. */
  async listRange(
    startDate: string,
    endDate: string,
    restingHeartRateCte: SQL = restingHeartRateValuesCte([]),
  ): Promise<HealthTrendRow[]> {
    return this.query(
      healthTrendRowSchema,
      sql`WITH ${restingHeartRateCte}
          SELECT dm.*, resting.resting_hr
          FROM fitness.v_daily_metrics dm
          LEFT JOIN resting_heart_rate resting ON resting.date = dm.date
          WHERE dm.user_id = ${this.userId}
            AND dm.date >= ${startDate}::date
            AND dm.date <= ${endDate}::date
            ${this.dateAccessPredicate(sql`dm.date`)}
          ORDER BY dm.date ASC`,
    );
  }

  /** Most recent single daily metrics row, or null if none exist. */
  async getLatest(): Promise<DailyMetricsViewRow | null> {
    const rows = await this.query(
      dailyMetricsViewRowSchema,
      sql`SELECT * FROM fitness.v_daily_metrics
          WHERE user_id = ${this.userId}
          ORDER BY date DESC LIMIT 1`,
    );
    return rows[0] ?? null;
  }

  /**
   * HRV baseline with rolling 60-day and 7-day window statistics.
   *
   * Fetches an extra 60 warmup days so the window functions have enough data
   * to produce accurate rolling averages from the first requested day, then
   * filters down to the requested date range client-side.
   */
  async getHrvBaseline(
    days: RangeDays,
    endDate: string,
    restingHeartRateCte: SQL = restingHeartRateValuesCte([]),
  ): Promise<HrvBaselineRow[]> {
    const warmupDays = rangeDaysOrNullAdd(days, HRV_BASELINE_WARMUP_DAYS);
    const rows = await this.query(
      hrvBaselineRowSchema,
      sql`WITH ${restingHeartRateCte},
          base_dates AS (
            SELECT date
            FROM fitness.v_daily_metrics
            WHERE user_id = ${this.userId}
              ${dateWindowStartPredicate(sql`date`, endDate, warmupDays)}
            UNION
            SELECT date
            FROM resting_heart_rate
          ),
          current AS (
            SELECT
              base_dates.date,
              dm.hrv,
              drhr.resting_hr
            FROM base_dates
            LEFT JOIN fitness.v_daily_metrics dm
              ON dm.user_id = ${this.userId}
             AND dm.date = base_dates.date
            LEFT JOIN resting_heart_rate drhr
              ON drhr.date = base_dates.date
            WHERE true
              ${dateWindowStartPredicate(sql`base_dates.date`, endDate, warmupDays)}
          )
          SELECT date, hrv, resting_hr,
            AVG(hrv) OVER (ORDER BY date ROWS BETWEEN 59 PRECEDING AND CURRENT ROW) AS mean_60d,
            STDDEV(hrv) OVER (ORDER BY date ROWS BETWEEN 59 PRECEDING AND CURRENT ROW) AS sd_60d,
            AVG(hrv) OVER (ORDER BY date ROWS BETWEEN 6 PRECEDING AND CURRENT ROW) AS mean_7d,
            AVG(resting_hr) OVER (ORDER BY date ROWS BETWEEN 6 PRECEDING AND CURRENT ROW) AS resting_hr_mean_7d
          FROM current
          ORDER BY date ASC`,
    );

    if (days === null) return rows.filter((row) => row.date <= endDate);

    // Discard warmup rows — only return the requested date range
    const cutoffStr = dateWindowStartString(endDate, days - 1);
    return rows.filter((row) => row.date >= cutoffStr && row.date <= endDate);
  }

  /** Aggregate trends (averages, standard deviations) and latest values for the date window. */
  async getTrends(
    days: RangeDays,
    endDate: string,
    restingHeartRateCte: SQL = restingHeartRateValuesCte([]),
  ): Promise<TrendsRow | null> {
    const evidenceWindowPredicate =
      days === null
        ? sql`AND date BETWEEN ${dateWindowStartString(endDate, HEALTH_METRIC_EVIDENCE_WINDOW_DAYS)} AND ${dateWindowEnd(endDate)}`
        : dateWindowStartPredicate(
            sql`date`,
            endDate,
            Math.max(days, HEALTH_METRIC_EVIDENCE_WINDOW_DAYS),
          );
    const rows = await this.query(
      trendsRowSchema,
      sql`WITH ${restingHeartRateCte},
          base_dates AS (
            SELECT date
            FROM fitness.v_daily_metrics
            WHERE user_id = ${this.userId}
              ${dateWindowStartPredicate(sql`date`, endDate, days)}
              AND date <= ${dateWindowEnd(endDate)}
            UNION
            SELECT date
            FROM resting_heart_rate
          ),
          current AS (
            SELECT
              base_dates.date,
              dm.hrv,
              drhr.resting_hr,
              dm.spo2_avg,
              dm.steps,
              dm.skin_temp_c,
              dm.source_providers
            FROM base_dates
            LEFT JOIN fitness.v_daily_metrics dm
              ON dm.user_id = ${this.userId}
             AND dm.date = base_dates.date
            LEFT JOIN resting_heart_rate drhr
              ON drhr.date = base_dates.date
            WHERE true
              ${dateWindowStartPredicate(sql`base_dates.date`, endDate, days)}
              AND base_dates.date <= ${dateWindowEnd(endDate)}
              ${this.dateAccessPredicate(sql`base_dates.date`)}
          ),
          evidence_current AS (
            SELECT
              date,
              hrv,
              spo2_avg,
              steps,
              skin_temp_c,
              source_providers
            FROM fitness.v_daily_metrics
            WHERE user_id = ${this.userId}
              ${evidenceWindowPredicate}
              AND date <= ${dateWindowEnd(endDate)}
              ${this.dateAccessPredicate(sql`date`)}
          ),
          stats AS (
            SELECT
              AVG(hrv) AS avg_hrv,
              AVG(resting_hr) AS avg_resting_hr,
              AVG(spo2_avg) AS avg_spo2,
              AVG(steps) AS avg_steps,
              AVG(skin_temp_c) AS avg_skin_temp,
              STDDEV(hrv) AS stddev_hrv,
              STDDEV(resting_hr) AS stddev_resting_hr,
              STDDEV(spo2_avg) AS stddev_spo2,
              STDDEV(steps) AS stddev_steps,
              STDDEV(skin_temp_c) AS stddev_skin_temp
            FROM current
          ),
          representative_resting_heart_rate AS (
            SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY recent.resting_hr) AS resting_hr
            FROM (
              SELECT resting_hr
              FROM current
              WHERE resting_hr > 0
              ORDER BY date DESC
              LIMIT 14
            ) recent
          ),
          latest AS (
            SELECT
              (ARRAY_AGG(hrv ORDER BY date DESC) FILTER (WHERE hrv IS NOT NULL))[1] AS hrv,
              (SELECT resting_hr FROM representative_resting_heart_rate) AS resting_hr,
              (ARRAY_AGG(spo2_avg ORDER BY date DESC) FILTER (WHERE spo2_avg IS NOT NULL))[1] AS spo2_avg,
              (ARRAY_AGG(steps ORDER BY date DESC) FILTER (WHERE steps IS NOT NULL))[1] AS steps,
              (ARRAY_AGG(skin_temp_c ORDER BY date DESC) FILTER (WHERE skin_temp_c IS NOT NULL))[1] AS skin_temp_c,
              (ARRAY_AGG(date ORDER BY date DESC) FILTER (WHERE steps IS NOT NULL))[1] AS steps_date,
              MAX(date) AS date
            FROM current
          ),
          metric_evidence AS (
            SELECT jsonb_build_object(
              'hrv', jsonb_build_object(
                'latestDate', (SELECT MAX(date) FROM evidence_current WHERE hrv IS NOT NULL),
                'sourceProviders', COALESCE((SELECT source_providers FROM evidence_current WHERE hrv IS NOT NULL ORDER BY date DESC LIMIT 1), ARRAY[]::text[]),
                'observedDays', (SELECT COUNT(*) FROM evidence_current WHERE hrv IS NOT NULL),
                'recentMean', (SELECT AVG(hrv) FROM evidence_current WHERE hrv IS NOT NULL AND date BETWEEN ((SELECT MAX(date) FROM evidence_current WHERE hrv IS NOT NULL) - 6) AND (SELECT MAX(date) FROM evidence_current WHERE hrv IS NOT NULL)),
                'baselineMean', (SELECT AVG(hrv) FROM evidence_current WHERE hrv IS NOT NULL AND date BETWEEN ((SELECT MAX(date) FROM evidence_current WHERE hrv IS NOT NULL) - 34) AND ((SELECT MAX(date) FROM evidence_current WHERE hrv IS NOT NULL) - 7))
              ),
              'spo2', jsonb_build_object(
                'latestDate', (SELECT MAX(date) FROM evidence_current WHERE spo2_avg IS NOT NULL),
                'sourceProviders', COALESCE((SELECT source_providers FROM evidence_current WHERE spo2_avg IS NOT NULL ORDER BY date DESC LIMIT 1), ARRAY[]::text[]),
                'observedDays', (SELECT COUNT(*) FROM evidence_current WHERE spo2_avg IS NOT NULL),
                'recentMean', (SELECT AVG(spo2_avg) FROM evidence_current WHERE spo2_avg IS NOT NULL AND date BETWEEN ((SELECT MAX(date) FROM evidence_current WHERE spo2_avg IS NOT NULL) - 6) AND (SELECT MAX(date) FROM evidence_current WHERE spo2_avg IS NOT NULL)),
                'baselineMean', (SELECT AVG(spo2_avg) FROM evidence_current WHERE spo2_avg IS NOT NULL AND date BETWEEN ((SELECT MAX(date) FROM evidence_current WHERE spo2_avg IS NOT NULL) - 34) AND ((SELECT MAX(date) FROM evidence_current WHERE spo2_avg IS NOT NULL) - 7))
              ),
              'steps', jsonb_build_object(
                'latestDate', (SELECT MAX(date) FROM evidence_current WHERE steps IS NOT NULL),
                'sourceProviders', COALESCE((SELECT source_providers FROM evidence_current WHERE steps IS NOT NULL ORDER BY date DESC LIMIT 1), ARRAY[]::text[]),
                'observedDays', (SELECT COUNT(*) FROM evidence_current WHERE steps IS NOT NULL),
                'recentMean', (SELECT AVG(steps) FROM evidence_current WHERE steps IS NOT NULL AND date BETWEEN ((SELECT MAX(date) FROM evidence_current WHERE steps IS NOT NULL) - 6) AND (SELECT MAX(date) FROM evidence_current WHERE steps IS NOT NULL)),
                'baselineMean', (SELECT AVG(steps) FROM evidence_current WHERE steps IS NOT NULL AND date BETWEEN ((SELECT MAX(date) FROM evidence_current WHERE steps IS NOT NULL) - 34) AND ((SELECT MAX(date) FROM evidence_current WHERE steps IS NOT NULL) - 7))
              ),
              'skin_temperature', jsonb_build_object(
                'latestDate', (SELECT MAX(date) FROM evidence_current WHERE skin_temp_c IS NOT NULL),
                'sourceProviders', COALESCE((SELECT source_providers FROM evidence_current WHERE skin_temp_c IS NOT NULL ORDER BY date DESC LIMIT 1), ARRAY[]::text[]),
                'observedDays', (SELECT COUNT(*) FROM evidence_current WHERE skin_temp_c IS NOT NULL),
                'recentMean', (SELECT AVG(skin_temp_c) FROM evidence_current WHERE skin_temp_c IS NOT NULL AND date BETWEEN ((SELECT MAX(date) FROM evidence_current WHERE skin_temp_c IS NOT NULL) - 6) AND (SELECT MAX(date) FROM evidence_current WHERE skin_temp_c IS NOT NULL)),
                'baselineMean', (SELECT AVG(skin_temp_c) FROM evidence_current WHERE skin_temp_c IS NOT NULL AND date BETWEEN ((SELECT MAX(date) FROM evidence_current WHERE skin_temp_c IS NOT NULL) - 34) AND ((SELECT MAX(date) FROM evidence_current WHERE skin_temp_c IS NOT NULL) - 7))
              )
            ) AS evidence
          )
          SELECT
            stats.*,
            latest.hrv AS latest_hrv,
            latest.resting_hr AS latest_resting_hr,
            latest.spo2_avg AS latest_spo2,
            CASE WHEN latest.steps_date = ${dateWindowEnd(endDate)} THEN latest.steps ELSE NULL END AS latest_steps,
            latest.skin_temp_c AS latest_skin_temp,
            latest.date AS latest_date,
            CASE WHEN latest.steps_date = ${dateWindowEnd(endDate)} THEN latest.steps_date ELSE NULL END AS latest_steps_date,
            metric_evidence.evidence AS metric_evidence
          FROM stats LEFT JOIN latest ON true CROSS JOIN metric_evidence`,
    );
    return rows[0] ?? null;
  }
}
