import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { dateStringSchema } from "../lib/typed-sql.ts";
import type { ActivitySensorStore } from "../repositories/activity-repository.ts";
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

export interface MonthSummary {
  monthStart: string;
  trainingHours: number;
  activityCount: number;
  avgDailyStrain: number;
  avgSleepMinutes: number;
  avgRestingHr: number | null;
  avgHrv: number | null;
  /** Month-over-month % change in training hours (null for first month) */
  trainingHoursTrend: number | null;
  /** Month-over-month % change in avg sleep (null for first month) */
  avgSleepTrend: number | null;
}

export interface MonthlyReportResult {
  current: MonthSummary | null;
  history: MonthSummary[];
}

const monthRowSchema = z.object({
  month_start: dateStringSchema,
  training_hours: z.coerce.number(),
  activity_count: z.coerce.number(),
  avg_daily_strain: z.coerce.number(),
  avg_sleep_minutes: z.coerce.number(),
  avg_resting_hr: z.coerce.number().nullable(),
  avg_hrv: z.coerce.number().nullable(),
});

export const monthlyReportRouter = router({
  /**
   * Monthly Performance Report — aggregates training, sleep, and vitals per calendar month
   * with month-over-month trends.
   */
  report: cachedProtectedQuery(CacheTTL.LONG)
    .input(z.object({ months: z.number().min(1).max(24).default(6) }))
    .query(async ({ ctx, input }): Promise<MonthlyReportResult> => {
      const sensorStore = requireSensorStore(ctx.sensorStore, "monthlyReport.report");
      const rows = await sensorStore.query(
        monthRowSchema,
        `WITH per_activity AS (
          SELECT
            toDate(started_at) AS date,
            dateDiff('second', started_at, ended_at) / 3600.0 AS hours,
            dateDiff('second', started_at, ended_at) / 60.0
              * avg_hr / nullIf(toFloat64(max_hr), 0) AS load
          FROM analytics.activity_summary
          WHERE user_id = {userId:UUID}
            AND started_at >= toStartOfMonth(today()) - INTERVAL {months:Int32} MONTH
            AND ended_at IS NOT NULL
            AND avg_hr IS NOT NULL
        ),
        daily_training AS (
          SELECT date, sum(hours) AS hours, toInt32(count()) AS count, sum(load) AS load
          FROM per_activity
          GROUP BY date
        ),
        sleep_raw AS (
          SELECT toDate(started_at) AS date, duration_minutes
          FROM analytics.v_sleep
          WHERE user_id = {userId:UUID}
            AND is_nap = false
            AND started_at >= toStartOfMonth(today()) - INTERVAL {months:Int32} MONTH
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
          LEFT JOIN analytics.derived_resting_heart_rate AS drhr
            ON drhr.user_id = dm.user_id AND drhr.date = dm.date
          WHERE dm.user_id = {userId:UUID}
            AND dm.date >= toStartOfMonth(today()) - INTERVAL {months:Int32} MONTH
        ),
        date_series AS (
          SELECT toStartOfMonth(today()) - INTERVAL {months:Int32} MONTH + INTERVAL number DAY AS date
          FROM numbers(toUInt64(dateDiff('day', toStartOfMonth(today()) - INTERVAL {months:Int32} MONTH, today()) + 1))
        )
        SELECT
          toString(toStartOfMonth(d.date)) AS month_start,
          coalesce(sum(dt.hours), 0) AS training_hours,
          toInt32(coalesce(sum(dt.count), 0)) AS activity_count,
          coalesce(avg(dt.load), 0) AS avg_daily_strain,
          coalesce(avg(sl.duration_minutes), 0) AS avg_sleep_minutes,
          avg(m.resting_hr) AS avg_resting_hr,
          avg(m.hrv) AS avg_hrv
        FROM date_series AS d
        LEFT JOIN daily_training dt ON dt.date = d.date
        LEFT JOIN sleep_daily sl ON sl.date = d.date
        LEFT JOIN metrics_daily m ON m.date = d.date
        GROUP BY toStartOfMonth(d.date)
        ORDER BY month_start ASC`,
        { userId: ctx.userId, months: input.months },
      );

      // Build summaries with month-over-month trends
      const summaries: MonthSummary[] = rows.map((row, idx) => {
        const prev = idx > 0 ? rows[idx - 1] : undefined;

        const trainingHours = Math.round(Number(row.training_hours) * 10) / 10;
        const avgSleepMinutes = Math.round(Number(row.avg_sleep_minutes));
        const prevTrainingHours = prev ? Number(prev.training_hours) : null;
        const prevAvgSleep = prev ? Number(prev.avg_sleep_minutes) : null;

        return {
          monthStart: row.month_start,
          trainingHours,
          activityCount: Number(row.activity_count),
          avgDailyStrain: Math.round(Number(row.avg_daily_strain) * 10) / 10,
          avgSleepMinutes,
          avgRestingHr:
            row.avg_resting_hr != null ? Math.round(Number(row.avg_resting_hr) * 10) / 10 : null,
          avgHrv: row.avg_hrv != null ? Math.round(Number(row.avg_hrv) * 10) / 10 : null,
          trainingHoursTrend:
            prevTrainingHours != null && prevTrainingHours > 0
              ? Math.round(((trainingHours - prevTrainingHours) / prevTrainingHours) * 1000) / 10
              : null,
          avgSleepTrend:
            prevAvgSleep != null && prevAvgSleep > 0
              ? Math.round(((avgSleepMinutes - prevAvgSleep) / prevAvgSleep) * 1000) / 10
              : null,
        };
      });

      const current = summaries.length > 0 ? (summaries[summaries.length - 1] ?? null) : null;
      const history = summaries.slice(0, -1);

      return { current, history };
    }),
});
