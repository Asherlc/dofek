import { sql } from "drizzle-orm";
import { z } from "zod";
import { BaseRepository } from "../lib/base-repository.ts";
import { dateWindowEnd, dateWindowStart } from "../lib/date-window.ts";
import { dateStringSchema } from "../lib/typed-sql.ts";

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
  active_energy_kcal: z.number().nullable(),
  basal_energy_kcal: z.number().nullable(),
  distance_km: z.number().nullable(),
  flights_climbed: z.number().nullable(),
  exercise_minutes: z.number().nullable(),
  stand_hours: z.number().nullable(),
  walking_speed: z.number().nullable(),
  source_providers: z.array(z.string()),
});

export type DailyMetricsViewRow = z.infer<typeof dailyMetricsViewRowSchema>;

const hrvBaselineRowSchema = z.object({
  date: dateStringSchema,
  hrv: z.coerce.number().nullable(),
  mean_60d: z.coerce.number().nullable(),
  sd_60d: z.coerce.number().nullable(),
  mean_7d: z.coerce.number().nullable(),
});

export type HrvBaselineRow = z.infer<typeof hrvBaselineRowSchema>;

const trendsRowSchema = z.object({
  avg_hrv: z.coerce.number().nullable(),
  avg_spo2: z.coerce.number().nullable(),
  avg_steps: z.coerce.number().nullable(),
  avg_active_energy: z.coerce.number().nullable(),
  avg_skin_temp: z.coerce.number().nullable(),
  stddev_hrv: z.coerce.number().nullable(),
  stddev_spo2: z.coerce.number().nullable(),
  stddev_skin_temp: z.coerce.number().nullable(),
  latest_hrv: z.coerce.number().nullable(),
  latest_spo2: z.coerce.number().nullable(),
  latest_steps: z.coerce.number().nullable(),
  latest_active_energy: z.coerce.number().nullable(),
  latest_skin_temp: z.coerce.number().nullable(),
  latest_date: dateStringSchema.nullable(),
  latest_steps_date: dateStringSchema.nullable(),
  latest_active_energy_date: dateStringSchema.nullable(),
});

export type TrendsRow = z.infer<typeof trendsRowSchema>;

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

/** Data access for daily health metrics (vitals, activity, body). */
export class DailyMetricsRepository extends BaseRepository {
  /** Daily metrics within the given date window, ordered by date ascending. */
  async list(days: number, endDate: string): Promise<DailyMetricsViewRow[]> {
    const rows = await this.query(
      dailyMetricsViewRowSchema,
      sql`SELECT * FROM fitness.v_daily_metrics
          WHERE user_id = ${this.userId}
            AND date > ${dateWindowStart(endDate, days)}
            AND date <= ${dateWindowEnd(endDate)}
            ${this.dateAccessPredicate(sql`date`)}
          ORDER BY date ASC`,
    );
    return rows;
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
  async getHrvBaseline(days: number, endDate: string): Promise<HrvBaselineRow[]> {
    const warmupDays = days + 60;
    const rows = await this.query(
      hrvBaselineRowSchema,
      sql`SELECT date, hrv,
            AVG(hrv) OVER (ORDER BY date ROWS BETWEEN 59 PRECEDING AND CURRENT ROW) AS mean_60d,
            STDDEV(hrv) OVER (ORDER BY date ROWS BETWEEN 59 PRECEDING AND CURRENT ROW) AS sd_60d,
            AVG(hrv) OVER (ORDER BY date ROWS BETWEEN 6 PRECEDING AND CURRENT ROW) AS mean_7d
          FROM fitness.v_daily_metrics
          WHERE user_id = ${this.userId}
            AND date > ${dateWindowStart(endDate, warmupDays)}
          ORDER BY date ASC`,
    );

    // Discard warmup rows — only return the requested date range
    const cutoffDate = new Date(`${endDate}T00:00:00`);
    cutoffDate.setDate(cutoffDate.getDate() - days);
    const cutoffStr = cutoffDate.toISOString().slice(0, 10);
    return rows.filter((row) => row.date >= cutoffStr);
  }

  /** Aggregate trends (averages, standard deviations) and latest values for the date window. */
  async getTrends(days: number, endDate: string): Promise<TrendsRow | null> {
    const trendsQuery = () =>
      this.query(
        trendsRowSchema,
        sql`WITH current AS (
              SELECT * FROM fitness.v_daily_metrics
              WHERE user_id = ${this.userId}
                AND date > ${dateWindowStart(endDate, days)}
                AND date <= ${dateWindowEnd(endDate)}
            ),
            stats AS (
              SELECT
                AVG(hrv) AS avg_hrv,
                AVG(spo2_avg) AS avg_spo2,
                AVG(steps) AS avg_steps,
                AVG(active_energy_kcal) AS avg_active_energy,
                AVG(skin_temp_c) AS avg_skin_temp,
                STDDEV(hrv) AS stddev_hrv,
                STDDEV(spo2_avg) AS stddev_spo2,
                STDDEV(skin_temp_c) AS stddev_skin_temp
              FROM current
            ),
            latest AS (
              SELECT
                (ARRAY_AGG(hrv ORDER BY date DESC) FILTER (WHERE hrv IS NOT NULL))[1] AS hrv,
                (ARRAY_AGG(spo2_avg ORDER BY date DESC) FILTER (WHERE spo2_avg IS NOT NULL))[1] AS spo2_avg,
                (ARRAY_AGG(steps ORDER BY date DESC) FILTER (WHERE steps IS NOT NULL))[1] AS steps,
                (ARRAY_AGG(active_energy_kcal ORDER BY date DESC) FILTER (WHERE active_energy_kcal IS NOT NULL))[1] AS active_energy_kcal,
                (ARRAY_AGG(skin_temp_c ORDER BY date DESC) FILTER (WHERE skin_temp_c IS NOT NULL))[1] AS skin_temp_c,
                (ARRAY_AGG(date ORDER BY date DESC) FILTER (WHERE steps IS NOT NULL))[1] AS steps_date,
                (ARRAY_AGG(date ORDER BY date DESC) FILTER (WHERE active_energy_kcal IS NOT NULL))[1] AS active_energy_kcal_date,
                MAX(date) AS date
              FROM current
            )
            SELECT
              stats.*,
              latest.hrv AS latest_hrv,
              latest.spo2_avg AS latest_spo2,
              latest.steps AS latest_steps,
              latest.active_energy_kcal AS latest_active_energy,
              latest.skin_temp_c AS latest_skin_temp,
              latest.date AS latest_date,
              latest.steps_date AS latest_steps_date,
              latest.active_energy_kcal_date AS latest_active_energy_date
            FROM stats LEFT JOIN latest ON true`,
      );

    const rows = await trendsQuery();
    const result = rows[0] ?? null;
    return result;
  }
}
