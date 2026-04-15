import * as Sentry from "@sentry/node";
import { type SQL, sql } from "drizzle-orm";
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
// Helpers
// ---------------------------------------------------------------------------

/** Number of calendar days between two YYYY-MM-DD date strings. */
function daysBetween(dateA: string, dateB: string): number {
  const msPerDay = 86_400_000;
  const timestampA = new Date(`${dateA}T00:00:00Z`).getTime();
  const timestampB = new Date(`${dateB}T00:00:00Z`).getTime();
  return Math.abs(Math.round((timestampB - timestampA) / msPerDay));
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

/**
 * Key metric columns to check for column-level staleness.
 * If ALL values for any of these are null in the view result but non-null
 * in the base table, the view is stale and needs a refresh.
 *
 * Limited to Apple Health activity metrics — these arrive via HealthKit push
 * (async from server-side syncs) and are most susceptible to the timing gap
 * where the view was refreshed before the push arrived. Recovery metrics
 * (resting_hr, hrv) come from server-side provider syncs that refresh the
 * view themselves, so they don't need this check.
 */
const KEY_METRICS = ["steps", "active_energy_kcal"] as const;
type KeyMetric = (typeof KEY_METRICS)[number];

const KEY_METRIC_TREND_FIELDS = {
  steps: { avg: "avg_steps", latest: "latest_steps" },
  active_energy_kcal: { avg: "avg_active_energy", latest: "latest_active_energy" },
} satisfies Record<KeyMetric, { avg: keyof TrendsRow; latest: keyof TrendsRow }>;

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
              AND date <= ${dateWindowEnd(endDate)}
            ORDER BY date ASC`,
      );

    const result = await listQuery();

    // View returned empty — check if base table has data (stale view)
    if (result.length === 0) {
      const refreshed = await this.#refreshIfStale(days, endDate);
      if (!refreshed) return result;
      return listQuery();
    }

    // View has data — check if it's stale (base table has newer rows).
    // Only check when the view's latest date is >1 day behind endDate to avoid
    // an extra query on every request when data is fresh.
    const latestViewDate = result[result.length - 1]?.date;
    if (
      latestViewDate != null &&
      latestViewDate < endDate &&
      daysBetween(latestViewDate, endDate) > 1 &&
      (await this.#baseTableHasNewerData(latestViewDate, endDate))
    ) {
      const refreshed = await this.#tryRefreshView("newer data in base table");
      if (refreshed) return listQuery();
    }

    // Recent-date staleness: older rows have data, but the latest visible row
    // is missing activity metrics that exist in the base table for that date.
    const latestRow = result[result.length - 1];
    if (latestRow && (await this.#latestRowMissingMetrics(latestRow, endDate))) {
      const refreshed = await this.#tryRefreshView(
        "latest row missing metrics present in base table",
      );
      if (refreshed) return listQuery();
    }

    // Window-level staleness: all values for a key metric are null in the
    // view, but the base table has non-null values somewhere in the window.
    if (await this.#windowMissingMetrics(result, days, endDate)) {
      const refreshed = await this.#tryRefreshView("view missing metrics present in base table");
      if (refreshed) return listQuery();
    }

    return result;
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

  async #windowMissingMetrics(
    result: DailyMetricsViewRow[],
    days: number,
    endDate: string,
  ): Promise<boolean> {
    const missingColumns = KEY_METRICS.filter((column) =>
      result.every((row) => row[column] == null),
    );
    if (missingColumns.length === 0) return false;
    return this.#baseTableHasMetricData(
      missingColumns,
      dateWindowStart(endDate, days),
      endDate,
      false,
    );
  }

  async #latestRowMissingMetrics(
    latestRow: DailyMetricsViewRow,
    endDate: string,
  ): Promise<boolean> {
    const missingColumns = KEY_METRICS.filter((column) => latestRow[column] == null);
    if (missingColumns.length === 0) return false;
    return this.#baseTableHasMetricData(missingColumns, latestRow.date, endDate, true);
  }

  /** Check if the base table has rows newer than what the materialized view returned. */
  async #baseTableHasNewerData(latestViewDate: string, endDate: string): Promise<boolean> {
    const rows = await this.query(
      z.object({ exists: z.coerce.number() }),
      sql`SELECT 1 AS exists FROM fitness.daily_metrics
          WHERE user_id = ${this.userId}
            AND date > ${latestViewDate}::date
            AND date <= ${dateWindowEnd(endDate)}
          LIMIT 1`,
    );
    return rows.length > 0;
  }

  /** Try to refresh the materialized view. Returns true on success, false on failure. */
  async #tryRefreshView(reason = "stale view"): Promise<boolean> {
    Sentry.captureMessage("Stale daily metrics materialized view detected", {
      level: "warning",
      tags: { userId: this.userId },
      extra: { reason },
    });
    logger.warn(`[daily-metrics] View stale for user ${this.userId} (${reason}), refreshing`);

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

  /**
   * Check if the base table has data in the window and refresh the view if stale.
   * Returns true if a refresh was performed, false otherwise.
   */
  async #refreshIfStale(days: number, endDate: string): Promise<boolean> {
    const baseRows = await this.query(
      z.object({ exists: z.coerce.number() }),
      sql`SELECT 1 AS exists FROM fitness.daily_metrics
          WHERE user_id = ${this.userId}
            AND date > ${dateWindowStart(endDate, days)}
            AND date <= ${dateWindowEnd(endDate)}
          LIMIT 1`,
    );
    if (baseRows.length === 0) return false;

    return this.#tryRefreshView("view empty but base table has data");
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
      if (!refreshed) return result;
      const retryRows = await trendsQuery();
      result = retryRows[0] ?? null;
    }

    if (
      result &&
      result.latest_date != null &&
      (await this.#latestTrendsMissingMetrics(result, endDate))
    ) {
      const refreshed = await this.#tryRefreshView(
        "latest trends missing metrics present in base table",
      );
      if (refreshed) {
        const retryRows = await trendsQuery();
        result = retryRows[0] ?? null;
      }
    }

    if (result && (await this.#windowTrendsMissingMetrics(result, days, endDate))) {
      const refreshed = await this.#tryRefreshView(
        "trend metrics missing in view but present in base table",
      );
      if (refreshed) {
        const retryRows = await trendsQuery();
        result = retryRows[0] ?? null;
      }
    }

    return result;
  }

  async #latestTrendsMissingMetrics(result: TrendsRow, endDate: string): Promise<boolean> {
    const missingColumns = KEY_METRICS.filter(
      (column) => result[KEY_METRIC_TREND_FIELDS[column].latest] == null,
    );
    if (missingColumns.length === 0 || result.latest_date == null) return false;
    return this.#baseTableHasMetricData(missingColumns, result.latest_date, endDate, true);
  }

  async #windowTrendsMissingMetrics(
    result: TrendsRow,
    days: number,
    endDate: string,
  ): Promise<boolean> {
    const missingColumns = KEY_METRICS.filter(
      (column) => result[KEY_METRIC_TREND_FIELDS[column].avg] == null,
    );
    if (missingColumns.length === 0) return false;
    return this.#baseTableHasMetricData(
      missingColumns,
      dateWindowStart(endDate, days),
      endDate,
      false,
    );
  }

  async #baseTableHasMetricData(
    columns: readonly KeyMetric[],
    startDate: SQL | string,
    endDate: string,
    includeStartDate: boolean,
  ): Promise<boolean> {
    const conditions = columns.map((column) => sql`${sql.identifier(column)} IS NOT NULL`);
    const startDateSql = typeof startDate === "string" ? sql`${startDate}::date` : startDate;
    const startCondition = includeStartDate
      ? sql`date >= ${startDateSql}`
      : sql`date > ${startDateSql}`;
    const rows = await this.query(
      z.object({ exists: z.coerce.number() }),
      sql`SELECT 1 AS exists FROM fitness.daily_metrics
          WHERE user_id = ${this.userId}
            AND ${startCondition}
            AND date <= ${dateWindowEnd(endDate)}
            AND (${sql.join(conditions, sql` OR `)})
          LIMIT 1`,
    );
    return rows.length > 0;
  }
}
