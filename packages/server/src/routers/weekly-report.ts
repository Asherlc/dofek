import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { dateWindowStartString, endDateSchema } from "../lib/date-window.ts";
import { dateStringSchema } from "../lib/typed-sql.ts";
import type { ActivitySensorStore } from "../repositories/activity-repository.ts";
import { restingHeartRateClickHouseCte } from "../repositories/resting-heart-rate-query.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

function requireSensorStore(
  sensorStore: ActivitySensorStore | undefined,
  feature: string,
): ActivitySensorStore {
  if (!sensorStore) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `${feature} requires the ClickHouse activity analytics store. Set CLICKHOUSE_URL and retry.`,
    });
  }
  return sensorStore;
}

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

export const weeklyReportRouter = router({
  /**
   * Weekly Performance Report — mirrors Whoop's Weekly Performance Assessment.
   * Aggregates strain balance, sleep performance, readiness, and key vitals per ISO week.
   */
  report: cachedProtectedQuery(CacheTTL.LONG)
    .input(z.object({ weeks: z.number().min(1).max(52).default(12), endDate: endDateSchema }))
    .query(async ({ ctx, input }): Promise<WeeklyReportResult> => {
      const sensorStore = requireSensorStore(ctx.sensorStore, "weeklyReport.report");
      const totalDays = input.weeks * 7 + 28; // extra for chronic baseline
      const windowStart = dateWindowStartString(input.endDate, totalDays);

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

      const rows = await sensorStore.query(
        weeklyReportRowSchema,
        `WITH ${restingHeartRateClickHouseCte()},
        per_activity AS (
          SELECT
            toDate(toTimeZone(started_at, {timezone:String})) AS date,
            dateDiff('second', started_at, ended_at) / 3600.0 AS hours,
            dateDiff('second', started_at, ended_at) / 60.0
              * avg_hr / nullIf(toFloat64(max_hr), 0) AS load
          FROM analytics.activity_summary
          WHERE user_id = {userId:UUID}
            AND toDate(toTimeZone(started_at, {timezone:String})) >= toDate({windowStart:String})
            AND ended_at IS NOT NULL
            AND avg_hr IS NOT NULL
        ),
        daily_training AS (
          SELECT date, sum(hours) AS hours, toInt32(count()) AS count, sum(load) AS load
          FROM per_activity
          GROUP BY date
        ),
        sleep_raw AS (
          SELECT
            toDate(toTimeZone(started_at, {timezone:String}) - INTERVAL 6 HOUR) AS date,
            duration_minutes
          FROM analytics.v_sleep
          WHERE user_id = {userId:UUID}
            AND is_nap = false
            AND started_at > toDateTime({windowStart:String})
        ),
        sleep_daily AS (
          SELECT date, max(duration_minutes) AS duration_minutes
          FROM sleep_raw
          GROUP BY date
        ),
        metrics_daily AS (
          SELECT
            dm.date AS date,
            drhr.resting_hr AS resting_hr,
            dm.hrv AS hrv
          FROM analytics.v_daily_metrics AS dm
          LEFT JOIN resting_heart_rate AS drhr
            ON drhr.date = toString(dm.date)
          WHERE dm.user_id = {userId:UUID}
            AND dm.date > toDate({windowStart:String})
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
            coalesce(dt.load, 0) AS load
          FROM date_series ds
          LEFT JOIN daily_training dt ON dt.date = ds.date
        ),
        weekly AS (
          SELECT
            toMonday(d.date) AS week_start,
            sum(d.hours) AS total_hours,
            toInt32(sum(d.count)) AS activity_count,
            avg(d.load) AS avg_daily_load,
            avg(sl.duration_minutes) AS avg_sleep_min,
            avg(m.resting_hr) AS avg_resting_hr,
            avg(m.hrv) AS avg_hrv
          FROM daily d
          LEFT JOIN sleep_daily sl ON sl.date = d.date
          LEFT JOIN metrics_daily m ON m.date = d.date
          GROUP BY toMonday(d.date)
          ORDER BY week_start ASC
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
        FROM weekly`,
        {
          userId: ctx.userId,
          timezone: ctx.timezone,
          windowStart,
          totalDays,
          rhrEndDate: input.endDate,
          rhrWindowStart: windowStart,
        },
      );

      const parsed = rows.map((row) => {
        const avgDailyLoad = Number(row.avg_daily_load) || 0;
        const chronicAvgLoad = Number(row.chronic_avg_load) || 0;
        const avgSleepMin = row.avg_sleep_min != null ? Number(row.avg_sleep_min) : 0;
        const prev3wkSleep = Number(row.prev_3wk_avg_sleep) || 0;

        return {
          weekStart: row.week_start,
          trainingHours: Math.round(Number(row.total_hours) * 10) / 10,
          activityCount: Number(row.activity_count),
          strainZone: classifyStrainZone(avgDailyLoad, chronicAvgLoad),
          avgDailyLoad: Math.round(avgDailyLoad * 10) / 10,
          avgSleepMinutes: Math.round(avgSleepMin),
          sleepPerformancePct:
            prev3wkSleep > 0 ? Math.round((avgSleepMin / prev3wkSleep) * 100) : 100,
          avgReadiness: 0, // filled below
          avgRestingHr:
            row.avg_resting_hr != null ? Math.round(Number(row.avg_resting_hr) * 10) / 10 : null,
          avgHrv: row.avg_hrv != null ? Math.round(Number(row.avg_hrv) * 10) / 10 : null,
        } satisfies WeekSummary;
      });

      // Only return the requested number of weeks.
      // If the most recent week just started (today is its first day), it has
      // no meaningful data yet — treat the previous full week as "current".
      const cutoffWeeks = parsed.slice(-input.weeks);
      const lastWeek = cutoffWeeks[cutoffWeeks.length - 1];
      const isPartialWeek = lastWeek && lastWeek.weekStart === getMondayOfWeek(input.endDate);
      const current =
        isPartialWeek && cutoffWeeks.length >= 2
          ? (cutoffWeeks[cutoffWeeks.length - 2] ?? null)
          : (lastWeek ?? null);
      const history = isPartialWeek ? cutoffWeeks.slice(0, -2) : cutoffWeeks.slice(0, -1);

      return { current, history };
    }),
});

/** Return the ISO Monday (YYYY-MM-DD) for the week containing `dateStr`. */
function getMondayOfWeek(dateStr: string): string {
  const date = new Date(`${dateStr}T12:00:00Z`);
  const day = date.getUTCDay(); // 0=Sun, 1=Mon, ...
  const diff = day === 0 ? 6 : day - 1; // days since Monday
  date.setUTCDate(date.getUTCDate() - diff);
  return date.toISOString().slice(0, 10);
}
