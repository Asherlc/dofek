import { z } from "zod";
import { dateWindowStartString } from "../lib/date-window.ts";
import { dateStringSchema } from "../lib/typed-sql.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Strain balance category based on ACWR-like load distribution */
export type StrainZone = "restoring" | "optimal" | "overreaching";

export interface WeekSummary {
  /** Week start date (Sunday) */
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
  readonly #userId: string;
  readonly #timezone: string;
  readonly #sensorStore: ActivitySensorStore;

  constructor(userId: string, timezone: string, sensorStore: ActivitySensorStore) {
    this.#userId = userId;
    this.#timezone = timezone;
    this.#sensorStore = sensorStore;
  }

  /** Fetch weekly performance report with strain zones, sleep performance, and vitals. */
  async getReport(weeks: number, endDate: string): Promise<WeeklyReportResult> {
    const totalDays = weeks * 7 + 28; // extra for chronic baseline
    const windowStart = dateWindowStartString(endDate, totalDays);

    const rows = await this.#sensorStore.query(
      weeklyReportRowSchema,
      `WITH per_activity AS (
        SELECT
          toDate(toTimeZone(asum.started_at, {timezone:String})) AS date,
          dateDiff('second', asum.started_at, asum.ended_at) / 3600.0 AS hours,
          dateDiff('second', asum.started_at, asum.ended_at) / 60.0
            * asum.avg_hr / nullIf(toFloat64(asum.max_hr), 0) AS load
        FROM analytics.activity_summary asum
        WHERE asum.user_id = {userId:UUID}
          AND toDate(toTimeZone(asum.started_at, {timezone:String})) >= toDate({windowStart:String})
          AND toDate(toTimeZone(asum.started_at, {timezone:String})) <= toDate({endDate:String})
          AND asum.ended_at IS NOT NULL
      ),
      daily_training AS (
        SELECT
          date,
          sum(hours) AS hours,
          toInt32(count()) AS count,
          sumIf(load, load IS NOT NULL) AS load
        FROM per_activity
        GROUP BY date
      ),
      sleep_daily AS (
        SELECT
          date,
          duration_minutes
        FROM analytics.daily_sleep FINAL
        WHERE user_id = {userId:UUID}
          AND is_deleted = 0
          AND date >= toDate({windowStart:String})
          AND date <= toDate({endDate:String})
      ),
      metrics_daily AS (
        SELECT
          recovery.date AS date,
          recovery.resting_hr AS resting_hr,
          recovery.hrv AS hrv
        FROM analytics.daily_recovery AS recovery FINAL
        WHERE recovery.user_id = {userId:UUID}
          AND recovery.is_deleted = 0
          AND recovery.date >= toDate({windowStart:String})
          AND recovery.date <= toDate({endDate:String})
      ),
      date_series AS (
        SELECT toDate({windowStart:String}) + INTERVAL number DAY AS date
        FROM numbers(toUInt64({totalDays:Int32}) + 1)
      ),
      daily AS (
        SELECT
          ds.date AS date,
          coalesce(dt.hours, 0) AS hours,
          coalesce(dt.count, 0) AS count,
          coalesce(dt.load, 0) AS load,
          dt.date = ds.date AS has_training_data
        FROM date_series ds
        LEFT JOIN daily_training dt ON dt.date = ds.date
      ),
      weekly AS (
        SELECT
          toStartOfWeek(d.date, 0) AS week_start,
          sum(d.hours) AS total_hours,
          toInt32(sum(d.count)) AS activity_count,
          avg(d.load) AS avg_daily_load,
          avg(nullIf(sl.duration_minutes, 0)) AS avg_sleep_min,
          avg(nullIf(m.resting_hr, 0)) AS avg_resting_hr,
          avg(nullIf(m.hrv, 0)) AS avg_hrv,
          countIf(d.has_training_data OR sl.date = d.date OR m.date = d.date) > 0 AS has_data
        FROM daily d
        LEFT JOIN sleep_daily sl ON sl.date = d.date
        LEFT JOIN metrics_daily m ON m.date = d.date
        GROUP BY toStartOfWeek(d.date, 0)
        ORDER BY week_start ASC
      ),
      weekly_with_report_presence AS (
        SELECT
          *,
          max(has_data) OVER () AS report_has_data
        FROM weekly
      )
      SELECT
        toString(week_start) AS week_start,
        total_hours,
        activity_count,
        avg_daily_load,
        avg_sleep_min,
        avg_resting_hr,
        avg_hrv,
        avg(avg_daily_load) OVER (ORDER BY week_start ROWS BETWEEN 3 PRECEDING AND CURRENT ROW) AS chronic_avg_load,
        avg(avg_sleep_min) OVER (ORDER BY week_start ROWS BETWEEN 3 PRECEDING AND 1 PRECEDING) AS prev_3wk_avg_sleep
      FROM weekly_with_report_presence
      WHERE report_has_data`,
      {
        userId: this.#userId,
        timezone: this.#timezone,
        windowStart,
        endDate,
        totalDays,
      },
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
