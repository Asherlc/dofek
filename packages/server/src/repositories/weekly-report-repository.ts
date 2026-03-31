import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { dateWindowEnd, dateWindowStart, timestampWindowStart } from "../lib/date-window.ts";
import { dateStringSchema, executeWithSchema } from "../lib/typed-sql.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Strain balance category based on ACWR-like load distribution */
export type StrainZone = "restoring" | "optimal" | "overreaching";

export interface WeekSummary {
  /** ISO week start date (Monday) */
  weekStart: string;
  /** Total training hours */
  trainingHours: number;
  /** Number of activities */
  activityCount: number;
  /** Strain balance zone based on the week's average daily load vs chronic baseline */
  strainZone: StrainZone;
  /** Average daily load for the week */
  avgDailyLoad: number;
  /** Average sleep duration (minutes) */
  avgSleepMinutes: number;
  /** Sleep performance: avg sleep vs 3-week rolling avg (percentage) */
  sleepPerformancePct: number;
  /** Average readiness score for the week */
  avgReadiness: number;
  /** Average resting HR */
  avgRestingHr: number | null;
  /** Average HRV */
  avgHrv: number | null;
}

export interface WeeklyReportResult {
  /** Current week's summary */
  current: WeekSummary | null;
  /** Previous weeks for comparison */
  history: WeekSummary[];
}

// ---------------------------------------------------------------------------
// Domain logic
// ---------------------------------------------------------------------------

/**
 * Classify a week's average daily load relative to chronic baseline.
 * Whoop uses strain zones: restoring (<80% chronic), optimal (80-130%), overreaching (>130%).
 */
export function classifyStrainZone(weekAvgLoad: number, chronicAvgLoad: number): StrainZone {
  if (chronicAvgLoad <= 0) return "optimal";
  const ratio = weekAvgLoad / chronicAvgLoad;
  if (ratio < 0.8) return "restoring";
  if (ratio > 1.3) return "overreaching";
  return "optimal";
}

// ---------------------------------------------------------------------------
// Domain model
// ---------------------------------------------------------------------------

export interface WeekRowData {
  weekStart: string;
  totalHours: number;
  activityCount: number;
  avgDailyLoad: number;
  avgSleepMin: number | null;
  avgRestingHr: number | null;
  avgHrv: number | null;
  chronicAvgLoad: number;
  prev3wkAvgSleep: number | null;
}

/** A single week's raw data from the database, with a method to produce a WeekSummary. */
export class WeekRow {
  readonly #data: WeekRowData;

  constructor(data: WeekRowData) {
    this.#data = data;
  }

  get weekStart(): string {
    return this.#data.weekStart;
  }

  get avgDailyLoad(): number {
    return this.#data.avgDailyLoad;
  }

  get chronicAvgLoad(): number {
    return this.#data.chronicAvgLoad;
  }

  /** Convert raw row data into a WeekSummary with computed fields. */
  toSummary(): WeekSummary {
    const avgSleepMin = this.#data.avgSleepMin ?? 0;
    const prev3wkSleep = this.#data.prev3wkAvgSleep;

    return {
      weekStart: this.#data.weekStart,
      trainingHours: Math.round(this.#data.totalHours * 10) / 10,
      activityCount: this.#data.activityCount,
      strainZone: classifyStrainZone(this.#data.avgDailyLoad, this.#data.chronicAvgLoad),
      avgDailyLoad: Math.round(this.#data.avgDailyLoad * 10) / 10,
      avgSleepMinutes: Math.round(avgSleepMin),
      sleepPerformancePct:
        prev3wkSleep != null && prev3wkSleep > 0
          ? Math.round((avgSleepMin / prev3wkSleep) * 100)
          : 100,
      avgReadiness: 0,
      avgRestingHr:
        this.#data.avgRestingHr != null ? Math.round(this.#data.avgRestingHr * 10) / 10 : null,
      avgHrv: this.#data.avgHrv != null ? Math.round(this.#data.avgHrv * 10) / 10 : null,
    };
  }
}

// ---------------------------------------------------------------------------
// Zod schema for raw DB rows
// ---------------------------------------------------------------------------

const weeklyReportRowSchema = z.object({
  week_start: dateStringSchema,
  total_hours: z.coerce.number(),
  activity_count: z.coerce.number(),
  avg_daily_load: z.coerce.number(),
  avg_sleep_min: z.coerce.number().nullable(),
  avg_resting_hr: z.coerce.number().nullable(),
  avg_hrv: z.coerce.number().nullable(),
  chronic_avg_load: z.coerce.number(),
  prev_3wk_avg_sleep: z.coerce.number().nullable(),
});

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

/** Data access for weekly performance report aggregates. */
export class WeeklyReportRepository {
  readonly #db: Pick<Database, "execute">;
  readonly #userId: string;
  readonly #timezone: string;

  constructor(db: Pick<Database, "execute">, userId: string, timezone: string) {
    this.#db = db;
    this.#userId = userId;
    this.#timezone = timezone;
  }

  /** Fetch weekly performance report with strain zones, sleep performance, and vitals. */
  async getReport(weeks: number, endDate: string): Promise<WeeklyReportResult> {
    const totalDays = weeks * 7 + 28; // extra for chronic baseline

    const rows = await executeWithSchema(
      this.#db,
      weeklyReportRowSchema,
      sql`WITH date_series AS (
            SELECT generate_series(
              ${dateWindowStart(endDate, totalDays)},
              ${dateWindowEnd(endDate)},
              '1 day'::interval
            )::date AS date
          ),
          per_activity AS (
            SELECT
              (asum.started_at AT TIME ZONE ${this.#timezone})::date AS date,
              EXTRACT(EPOCH FROM (asum.ended_at - asum.started_at)) / 3600.0 AS hours,
              EXTRACT(EPOCH FROM (asum.ended_at - asum.started_at)) / 60.0
                * asum.avg_hr / NULLIF(asum.max_hr, 0) AS load
            FROM fitness.activity_summary asum
            WHERE asum.user_id = ${this.#userId}
              AND (asum.started_at AT TIME ZONE ${this.#timezone})::date >= ${dateWindowStart(endDate, totalDays)}
              AND asum.ended_at IS NOT NULL
              AND asum.avg_hr IS NOT NULL
          ),
          daily_training AS (
            SELECT date, SUM(hours) AS hours, COUNT(*) AS count, SUM(load) AS load
            FROM per_activity
            GROUP BY date
          ),
          daily AS (
            SELECT
              ds.date,
              COALESCE(dt.hours, 0) AS hours,
              COALESCE(dt.count, 0) AS count,
              COALESCE(dt.load, 0) AS load
            FROM date_series ds
            LEFT JOIN daily_training dt ON dt.date = ds.date
          ),
          sleep_raw AS (
            SELECT
              (started_at AT TIME ZONE ${this.#timezone})::date AS date,
              duration_minutes
            FROM fitness.v_sleep
            WHERE user_id = ${this.#userId}
              AND is_nap = false
              AND started_at > ${timestampWindowStart(endDate, totalDays)}
          ),
          sleep_daily AS (
            SELECT DISTINCT ON (date) date, duration_minutes
            FROM sleep_raw
            ORDER BY date, duration_minutes DESC NULLS LAST
          ),
          metrics_daily AS (
            SELECT
              date,
              resting_hr,
              hrv
            FROM fitness.v_daily_metrics
            WHERE user_id = ${this.#userId}
              AND date > ${dateWindowStart(endDate, totalDays)}
          ),
          weekly AS (
            SELECT
              date_trunc('week', d.date)::date AS week_start,
              SUM(d.hours) AS total_hours,
              SUM(d.count)::int AS activity_count,
              AVG(d.load) AS avg_daily_load,
              AVG(sl.duration_minutes) AS avg_sleep_min,
              AVG(m.resting_hr) AS avg_resting_hr,
              AVG(m.hrv) AS avg_hrv
            FROM daily d
            LEFT JOIN sleep_daily sl ON sl.date = d.date
            LEFT JOIN metrics_daily m ON m.date = d.date
            GROUP BY date_trunc('week', d.date)
            ORDER BY week_start ASC
          )
          SELECT
            week_start::text,
            total_hours,
            activity_count,
            avg_daily_load,
            avg_sleep_min,
            avg_resting_hr,
            avg_hrv,
            AVG(avg_daily_load) OVER (ORDER BY week_start ROWS BETWEEN 3 PRECEDING AND CURRENT ROW) AS chronic_avg_load,
            AVG(avg_sleep_min) OVER (ORDER BY week_start ROWS BETWEEN 3 PRECEDING AND 1 PRECEDING) AS prev_3wk_avg_sleep
          FROM weekly`,
    );

    const weekRows = rows.map(
      (row) =>
        new WeekRow({
          weekStart: row.week_start,
          totalHours: Number(row.total_hours) || 0,
          activityCount: Number(row.activity_count),
          avgDailyLoad: Number(row.avg_daily_load) || 0,
          avgSleepMin: row.avg_sleep_min,
          avgRestingHr: row.avg_resting_hr,
          avgHrv: row.avg_hrv,
          chronicAvgLoad: Number(row.chronic_avg_load) || 0,
          prev3wkAvgSleep: row.prev_3wk_avg_sleep,
        }),
    );

    const summaries = weekRows.map((weekRow) => weekRow.toSummary());

    // Only return the requested number of weeks
    const cutoffWeeks = summaries.slice(-weeks);
    const current = cutoffWeeks.length > 0 ? (cutoffWeeks[cutoffWeeks.length - 1] ?? null) : null;
    const history = cutoffWeeks.slice(0, -1);

    return { current, history };
  }
}
