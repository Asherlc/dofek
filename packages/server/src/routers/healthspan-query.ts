import { averageVo2MaxEstimates } from "@dofek/training/derived-cardio";
import { ZONE_BOUNDARIES_FTP } from "@dofek/zones/zones";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { dateWindowStart, timestampWindowStart } from "../lib/date-window.ts";
import { dateStringSchema, executeWithSchema } from "../lib/typed-sql.ts";
import { fetchBodyCompRows } from "../repositories/body-clickhouse.ts";
import { fetchSleepNights } from "../repositories/clickhouse-sleep-repository.ts";
import {
  fetchRestingHeartRateRows,
  type RestingHeartRateRow,
  restingHeartRateValuesCte,
} from "../repositories/resting-heart-rate-query.ts";
import type { AuthenticatedContext } from "../trpc.ts";

const historyRowSchema = z.object({
  week_start: dateStringSchema,
  avg_rhr: z.coerce.number().nullable(),
  avg_steps: z.coerce.number().nullable(),
  avg_vo2max: z.coerce.number().nullable(),
});

const rawRowSchema = z.object({
  avg_sleep_min: z.coerce.number().nullable(),
  bedtime_stddev_min: z.coerce.number().nullable(),
  avg_resting_hr: z.coerce.number().nullable(),
  avg_steps: z.coerce.number().nullable(),
  latest_vo2max: z.coerce.number().nullable(),
  weekly_aerobic_min: z.coerce.number().nullable(),
  weekly_high_intensity_min: z.coerce.number().nullable(),
  sessions_per_week: z.coerce.number().nullable(),
  weight_kg: z.coerce.number().nullable(),
  body_fat_pct: z.coerce.number().nullable(),
  weekly_history: z.array(historyRowSchema).nullable(),
});

export type HealthspanRawRow = z.infer<typeof rawRowSchema>;

type WeeklyHistoryRow = z.infer<typeof historyRowSchema>;
type HealthspanRawDataContext = Pick<
  AuthenticatedContext,
  "accessWindow" | "sensorStore" | "timezone" | "userId"
> & {
  db: Parameters<typeof executeWithSchema>[0];
};

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function populationStddev(values: number[]): number | null {
  const mean = average(values);
  if (mean == null) return null;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function bedtimeMinutes(timestamp: string, timezone: string): number | null {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  const minutes = hour * 60 + minute;
  return minutes < 720 ? minutes + 1440 : minutes;
}

/**
 * Compute total aerobic and high-intensity minutes from analytics.deduped_sensor.
 * Uses user_profile plus bounded helper-provided resting heart-rate rows.
 */
async function fetchHrZoneTime(
  ctx: HealthspanRawDataContext,
  endDate: string,
  totalDays: number,
  restingHeartRateRows: RestingHeartRateRow[],
): Promise<{ aerobic_minutes: number; high_intensity_minutes: number }> {
  const sensorStore = ctx.sensorStore;
  if (!sensorStore) return { aerobic_minutes: 0, high_intensity_minutes: 0 };

  const windowStart = new Date(endDate);
  windowStart.setUTCDate(windowStart.getUTCDate() - totalDays);
  const windowStartTimestamp = windowStart
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, "");

  const rows = await sensorStore.query(
    z.object({
      aerobic_minutes: z.coerce.number(),
      high_intensity_minutes: z.coerce.number(),
    }),
    `WITH activity_metadata AS (
      SELECT
        asum.activity_id AS activity_id,
        asum.started_at AS started_at,
        asum.ended_at AS ended_at,
        dateDiff('second', asum.started_at, asum.ended_at) / 60.0 AS duration_minutes,
        up.max_hr AS max_hr,
        up.ftp AS ftp,
        coalesce(
          if(
            indexOf({restingHeartRateDates:Array(String)}, toString(toDate(asum.started_at))) > 0,
            arrayElement(
              {restingHeartRates:Array(Float64)},
              indexOf({restingHeartRateDates:Array(String)}, toString(toDate(asum.started_at)))
            ),
            NULL
          ),
          up.resting_hr
        ) AS resting_hr
      FROM analytics.activity_summary AS asum
      INNER JOIN postgres_fitness.user_profile_current AS up
        ON up.id = asum.user_id
      WHERE asum.user_id = {userId:UUID}
        AND asum.started_at > toDateTime({windowStart:String})
        AND asum.ended_at IS NOT NULL
        AND (up.max_hr IS NOT NULL OR up.ftp IS NOT NULL)
    ),
    sensor_counts AS (
      SELECT
        am.activity_id AS activity_id,
        am.duration_minutes AS duration_minutes,
        am.max_hr AS max_hr,
        am.ftp AS ftp,
        am.resting_hr AS resting_hr,
        countIf(ds.channel = 'heart_rate') AS hr_sample_count,
        countIf(ds.channel = 'power') AS power_sample_count,
        countIf(ds.channel = 'heart_rate'
          AND am.resting_hr IS NOT NULL
          AND ds.scalar < am.resting_hr + (am.max_hr - am.resting_hr) * 0.8) AS aerobic_count,
        countIf(ds.channel = 'heart_rate'
          AND am.resting_hr IS NOT NULL
          AND ds.scalar >= am.resting_hr + (am.max_hr - am.resting_hr) * 0.8) AS hr_hi_count,
        countIf(ds.channel = 'power'
          AND am.ftp IS NOT NULL
          AND ds.scalar >= am.ftp * {powerThreshold:Float64}) AS power_hi_count
      FROM activity_metadata AS am
      LEFT JOIN analytics.deduped_sensor AS ds
        ON ds.activity_id = am.activity_id
       AND ds.channel IN ('heart_rate', 'power')
      GROUP BY am.activity_id, am.duration_minutes, am.max_hr, am.ftp, am.resting_hr
    )
    SELECT
      sum(if(max_hr IS NOT NULL AND resting_hr IS NOT NULL AND hr_sample_count > 0,
        toFloat64(aerobic_count) / toFloat64(hr_sample_count) * duration_minutes,
        0)) AS aerobic_minutes,
      sum(greatest(
        if(max_hr IS NOT NULL AND resting_hr IS NOT NULL AND hr_sample_count > 0,
          toFloat64(hr_hi_count) / toFloat64(hr_sample_count) * duration_minutes,
          0),
        if(ftp IS NOT NULL AND power_sample_count > 0,
          toFloat64(power_hi_count) / toFloat64(power_sample_count) * duration_minutes,
          0)
      )) AS high_intensity_minutes
    FROM sensor_counts`,
    {
      userId: ctx.userId,
      timezone: ctx.timezone,
      windowStart: windowStartTimestamp,
      powerThreshold: ZONE_BOUNDARIES_FTP[2],
      restingHeartRateDates: restingHeartRateRows.map((row) => row.date),
      restingHeartRates: restingHeartRateRows.map((row) => row.resting_hr),
    },
  );

  return rows[0] ?? { aerobic_minutes: 0, high_intensity_minutes: 0 };
}

/**
 * Fetch the raw aggregates and weekly history needed to compute a Healthspan score.
 *
 * Returns a single row with all nine metric inputs plus a JSON-aggregated
 * weekly history for the trend subset (resting HR, steps, VO2 max). The query
 * normalizes bedtime across midnight to avoid inflating the stddev for people
 * whose bedtimes straddle 00:00.
 */
export async function fetchHealthspanRawData(
  ctx: HealthspanRawDataContext,
  endDate: string,
  totalDays: number,
): Promise<HealthspanRawRow | null> {
  const restingHeartRateRows = ctx.sensorStore
    ? await fetchRestingHeartRateRows({
        sensorStore: ctx.sensorStore,
        userId: ctx.userId,
        timezone: ctx.timezone,
        endDate,
        days: totalDays,
      })
    : [];
  const restingHeartRateCte = restingHeartRateValuesCte(restingHeartRateRows);
  const hrZoneTime = await fetchHrZoneTime(ctx, endDate, totalDays, restingHeartRateRows);
  const weeklyDivisor = Math.max(totalDays / 7, 1);
  const weeklyAerobicMin = hrZoneTime.aerobic_minutes / weeklyDivisor;
  const weeklyHighIntensityMin = hrZoneTime.high_intensity_minutes / weeklyDivisor;
  const bodyMeasurements = ctx.sensorStore
    ? await fetchBodyCompRows(ctx.sensorStore, ctx.userId, endDate, totalDays)
    : [];
  const latestWeightKg = latestNonNullValue(bodyMeasurements, "weight_kg");
  const latestBodyFatPct = latestNonNullValue(bodyMeasurements, "body_fat_pct");
  const sleepRows = ctx.sensorStore
    ? await fetchSleepNights({
        sensorStore: ctx.sensorStore,
        userId: ctx.userId,
        timezone: ctx.timezone,
        endDate,
        days: totalDays,
        accessWindow: ctx.accessWindow,
        order: "asc",
      })
    : [];
  const sleepDurations = sleepRows
    .map((row) => row.duration_minutes)
    .filter((duration): duration is number => duration != null);
  const bedtimes = sleepRows
    .map((row) => bedtimeMinutes(row.started_at, ctx.timezone))
    .filter((minutes): minutes is number => minutes != null);
  const avgSleepMin = average(sleepDurations);
  const bedtimeStddevMin = populationStddev(bedtimes);

  const rows = await executeWithSchema(
    ctx.db,
    rawRowSchema,
    sql`WITH ${restingHeartRateCte},
        metrics_agg AS (
          SELECT
            (SELECT AVG(resting_hr)
             FROM resting_heart_rate
             WHERE date > ${dateWindowStart(endDate, totalDays)}) AS avg_resting_hr,
            (SELECT AVG(steps)
             FROM fitness.v_daily_metrics
             WHERE user_id = ${ctx.userId}
               AND date > ${dateWindowStart(endDate, totalDays)}) AS avg_steps,
            NULL::real AS latest_vo2max
        ),
        strength_freq AS (
          SELECT NULLIF(COUNT(*), 0)::real / GREATEST(${totalDays}::real / 7, 1) AS sessions_per_week
          FROM fitness.activity
          WHERE user_id = ${ctx.userId}
            AND activity_type = 'strength'
            AND started_at > ${timestampWindowStart(endDate, totalDays)}
        ),
        weekly_rhr AS (
          SELECT
            date_trunc('week', date)::date AS week_start,
            AVG(resting_hr) AS avg_rhr
          FROM resting_heart_rate
          WHERE date > ${dateWindowStart(endDate, totalDays)}
          GROUP BY date_trunc('week', date)
        ),
        weekly_steps AS (
          SELECT
            date_trunc('week', date)::date AS week_start,
            AVG(steps) AS avg_steps
          FROM fitness.v_daily_metrics
          WHERE user_id = ${ctx.userId}
            AND date > ${dateWindowStart(endDate, totalDays)}
          GROUP BY date_trunc('week', date)
        ),
        weekly_dates AS (
          SELECT week_start FROM weekly_rhr
          UNION
          SELECT week_start FROM weekly_steps
        ),
        weekly_metrics AS (
          SELECT
            wd.week_start,
            wr.avg_rhr,
            ws.avg_steps,
            NULL::real AS avg_vo2max
          FROM weekly_dates wd
          LEFT JOIN weekly_rhr wr ON wr.week_start = wd.week_start
          LEFT JOIN weekly_steps ws ON ws.week_start = wd.week_start
          ORDER BY week_start ASC
        )
        SELECT
          ${avgSleepMin}::real AS avg_sleep_min,
          ${bedtimeStddevMin}::real AS bedtime_stddev_min,
          ma.avg_resting_hr,
          ma.avg_steps,
          ma.latest_vo2max,
          ${weeklyAerobicMin}::real AS weekly_aerobic_min,
          ${weeklyHighIntensityMin}::real AS weekly_high_intensity_min,
          sf.sessions_per_week,
          ${latestWeightKg}::real AS weight_kg,
          ${latestBodyFatPct}::real AS body_fat_pct,
          (SELECT json_agg(json_build_object(
            'week_start', wm.week_start::text,
            'avg_rhr', wm.avg_rhr,
            'avg_steps', wm.avg_steps,
            'avg_vo2max', wm.avg_vo2max
          ) ORDER BY wm.week_start ASC) FROM weekly_metrics wm) AS weekly_history
        FROM metrics_agg ma
        CROSS JOIN strength_freq sf`,
  );

  const row = rows[0] ?? null;
  if (!row || !ctx.sensorStore) {
    return row;
  }

  const vo2MaxEstimates = await ctx.sensorStore.getVo2MaxEstimates(
    endDate,
    totalDays,
    ctx.userId,
    ctx.timezone,
  );
  return {
    ...row,
    latest_vo2max: averageVo2MaxEstimates(vo2MaxEstimates.map((estimate) => estimate.vo2max)),
    weekly_history: mergeWeeklyVo2Max(row.weekly_history, vo2MaxEstimates),
  };
}

function latestNonNullValue<TRow extends Record<TKey, number | null>, TKey extends string>(
  rows: TRow[],
  key: TKey,
): number | null {
  for (let rowIndex = rows.length - 1; rowIndex >= 0; rowIndex -= 1) {
    const value = rows[rowIndex]?.[key];
    if (value != null) {
      return Number(value);
    }
  }
  return null;
}

function mergeWeeklyVo2Max(
  history: WeeklyHistoryRow[] | null,
  estimates: Array<{ activity_date: string; vo2max: number }>,
): WeeklyHistoryRow[] | null {
  const weeklyRows = new Map<string, WeeklyHistoryRow>();
  for (const row of history ?? []) {
    weeklyRows.set(row.week_start, row);
  }

  const estimatesByWeek = new Map<string, number[]>();
  for (const estimate of estimates) {
    const weekStart = getIsoWeekStart(estimate.activity_date);
    const weekEstimates = estimatesByWeek.get(weekStart) ?? [];
    weekEstimates.push(estimate.vo2max);
    estimatesByWeek.set(weekStart, weekEstimates);
  }

  for (const [weekStart, weekEstimates] of estimatesByWeek) {
    const existing = weeklyRows.get(weekStart);
    weeklyRows.set(weekStart, {
      week_start: weekStart,
      avg_rhr: existing?.avg_rhr ?? null,
      avg_steps: existing?.avg_steps ?? null,
      avg_vo2max: averageVo2MaxEstimates(weekEstimates),
    });
  }

  const mergedRows = [...weeklyRows.values()].sort((left, right) =>
    left.week_start.localeCompare(right.week_start),
  );
  return mergedRows.length > 0 ? mergedRows : history;
}

function getIsoWeekStart(dateString: string): string {
  const date = new Date(`${dateString}T00:00:00.000Z`);
  const daysSinceMonday = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - daysSinceMonday);
  return date.toISOString().slice(0, 10);
}
