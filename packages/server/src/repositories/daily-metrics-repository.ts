import * as Sentry from "@sentry/node";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { BaseRepository } from "../lib/base-repository.ts";
import { dateWindowEnd, dateWindowStart } from "../lib/date-window.ts";
import { dateStringSchema } from "../lib/typed-sql.ts";
import { logger } from "../logger.ts";

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const dailyMetricsViewRowSchema = z.object({
  date: dateStringSchema,
  user_id: z.string(),
  resting_hr: z.number().nullable(),
  hrv: z.number().nullable(),
  vo2max: z.number().nullable(),
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
  resting_hr: z.coerce.number().nullable(),
  mean_60d: z.coerce.number().nullable(),
  sd_60d: z.coerce.number().nullable(),
  mean_7d: z.coerce.number().nullable(),
});

export type HrvBaselineRow = z.infer<typeof hrvBaselineRowSchema>;

const trendsRowSchema = z.object({
  avg_resting_hr: z.coerce.number().nullable(),
  avg_hrv: z.coerce.number().nullable(),
  avg_spo2: z.coerce.number().nullable(),
  avg_steps: z.coerce.number().nullable(),
  avg_active_energy: z.coerce.number().nullable(),
  avg_skin_temp: z.coerce.number().nullable(),
  stddev_resting_hr: z.coerce.number().nullable(),
  stddev_hrv: z.coerce.number().nullable(),
  stddev_spo2: z.coerce.number().nullable(),
  stddev_skin_temp: z.coerce.number().nullable(),
  latest_resting_hr: z.coerce.number().nullable(),
  latest_hrv: z.coerce.number().nullable(),
  latest_spo2: z.coerce.number().nullable(),
  latest_steps: z.coerce.number().nullable(),
  latest_active_energy: z.coerce.number().nullable(),
  latest_skin_temp: z.coerce.number().nullable(),
  latest_date: dateStringSchema.nullable(),
});

export type TrendsRow = z.infer<typeof trendsRowSchema>;

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

/** Data access for daily health metrics (vitals, activity, body). */
export class DailyMetricsRepository extends BaseRepository {
  /** Daily metrics within the given date window, ordered by date ascending. */
  async list(days: number, endDate: string): Promise<DailyMetricsViewRow[]> {
    const listQuery = () =>
      this.query(
        dailyMetricsViewRowSchema,
        sql`SELECT * FROM fitness.v_daily_metrics
            WHERE user_id = ${this.userId}
              AND date > ${dateWindowStart(endDate, days)}
            ORDER BY date ASC`,
      );

    const result = await listQuery();
    if (result.length > 0) return result;

    // View returned empty — check if base table has data (stale view)
    const refreshed = await this.#refreshIfStale(days, endDate);
    if (!refreshed) return result;
    return listQuery();
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
      sql`SELECT date, hrv, resting_hr,
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

  /**
   * Check if the base table has data in the window and refresh the view if stale.
   * Returns true if a refresh was performed, false otherwise.
   */
  async #refreshIfStale(days: number, endDate: string): Promise<boolean> {
    const baseCount = await this.query(
      z.object({ count: z.coerce.number() }),
      sql`SELECT count(*)::int AS count FROM fitness.daily_metrics
          WHERE user_id = ${this.userId}
            AND date > ${dateWindowStart(endDate, days)}
            AND date <= ${dateWindowEnd(endDate)}
          LIMIT 1`,
    );
    if ((baseCount[0]?.count ?? 0) === 0) return false;

    Sentry.captureMessage("Stale daily metrics materialized view detected", {
      level: "warning",
      tags: { userId: this.userId },
      extra: { days, endDate, baseCount: baseCount[0]?.count },
    });
    logger.warn(
      `[daily-metrics] View stale for user ${this.userId} (days=${days}, endDate=${endDate}), refreshing`,
    );

    try {
      try {
        await this.db.execute(
          sql.raw("REFRESH MATERIALIZED VIEW CONCURRENTLY fitness.v_daily_metrics"),
        );
      } catch {
        await this.db.execute(sql.raw("REFRESH MATERIALIZED VIEW fitness.v_daily_metrics"));
      }
    } catch (refreshError) {
      Sentry.captureException(refreshError, {
        tags: { userId: this.userId, context: "staleDailyMetricsRefresh" },
      });
      return false;
    }
    return true;
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
                AVG(resting_hr) AS avg_resting_hr,
                AVG(hrv) AS avg_hrv,
                AVG(spo2_avg) AS avg_spo2,
                AVG(steps) AS avg_steps,
                AVG(active_energy_kcal) AS avg_active_energy,
                AVG(skin_temp_c) AS avg_skin_temp,
                STDDEV(resting_hr) AS stddev_resting_hr,
                STDDEV(hrv) AS stddev_hrv,
                STDDEV(spo2_avg) AS stddev_spo2,
                STDDEV(skin_temp_c) AS stddev_skin_temp
              FROM current
            ),
            latest AS (
              SELECT resting_hr, hrv, spo2_avg, steps, active_energy_kcal, skin_temp_c, date
              FROM current
              ORDER BY date DESC
              LIMIT 1
            )
            SELECT
              stats.*,
              latest.resting_hr AS latest_resting_hr,
              latest.hrv AS latest_hrv,
              latest.spo2_avg AS latest_spo2,
              latest.steps AS latest_steps,
              latest.active_energy_kcal AS latest_active_energy,
              latest.skin_temp_c AS latest_skin_temp,
              latest.date AS latest_date
            FROM stats LEFT JOIN latest ON true`,
      );

    const rows = await trendsQuery();
    let result = rows[0] ?? null;
    if (result && result.latest_date === null && result.avg_resting_hr === null) {
      // View returned all nulls — check if base table has data (stale view)
      const refreshed = await this.#refreshIfStale(days, endDate);
      if (refreshed) {
        const retryRows = await trendsQuery();
        result = retryRows[0] ?? null;
      }
    }
    return result;
  }
}
