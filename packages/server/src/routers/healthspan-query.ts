import { sql } from "drizzle-orm";
import { z } from "zod";
import { dateWindowStart, timestampWindowStart } from "../lib/date-window.ts";
import { sleepNightDate } from "../lib/sql-fragments.ts";
import { dateStringSchema, executeWithSchema } from "../lib/typed-sql.ts";
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

/**
 * Fetch the raw aggregates and weekly history needed to compute a Healthspan score.
 *
 * Returns a single row with all nine metric inputs plus a JSON-aggregated
 * weekly history for the trend subset (resting HR, steps, VO2 max). The query
 * normalizes bedtime across midnight to avoid inflating the stddev for people
 * whose bedtimes straddle 00:00.
 */
export async function fetchHealthspanRawData(
  ctx: AuthenticatedContext,
  endDate: string,
  totalDays: number,
): Promise<HealthspanRawRow | null> {
  const rows = await executeWithSchema(
    ctx.db,
    rawRowSchema,
    sql`WITH sleep_raw AS (
          SELECT
            ${sleepNightDate(ctx.timezone)} AS date,
            duration_minutes,
            -- Normalize bedtime to a continuous scale to avoid midnight wraparound.
            -- Raw minutes-of-day (0-1439) cause huge stddev when bedtimes straddle midnight
            -- (e.g. 11 PM = 1380 and 1 AM = 60 appear 1320 min apart instead of 120 min).
            -- Adding 1440 to any time before noon (< 720 min) places all typical sleep
            -- start times in a continuous 1200-2160 range (8 PM to 12 PM next day).
            CASE
              WHEN EXTRACT(HOUR FROM started_at AT TIME ZONE ${ctx.timezone}) * 60
                   + EXTRACT(MINUTE FROM started_at AT TIME ZONE ${ctx.timezone}) < 720
              THEN EXTRACT(HOUR FROM started_at AT TIME ZONE ${ctx.timezone}) * 60
                   + EXTRACT(MINUTE FROM started_at AT TIME ZONE ${ctx.timezone}) + 1440
              ELSE EXTRACT(HOUR FROM started_at AT TIME ZONE ${ctx.timezone}) * 60
                   + EXTRACT(MINUTE FROM started_at AT TIME ZONE ${ctx.timezone})
            END AS bedtime_minutes
          FROM fitness.v_sleep
          WHERE user_id = ${ctx.userId}
            AND is_nap = false
            AND started_at > ${timestampWindowStart(endDate, totalDays)}
        ),
        sleep_data AS (
          SELECT DISTINCT ON (date) date, duration_minutes, bedtime_minutes
          FROM sleep_raw
          ORDER BY date, duration_minutes DESC NULLS LAST
        ),
        sleep_agg AS (
          SELECT
            AVG(duration_minutes) AS avg_sleep_min,
            STDDEV_POP(bedtime_minutes) AS bedtime_stddev_min
          FROM sleep_data
        ),
        metrics_agg AS (
          SELECT
            AVG(resting_hr) AS avg_resting_hr,
            AVG(steps) AS avg_steps,
            (SELECT vo2max FROM fitness.v_daily_metrics
             WHERE user_id = ${ctx.userId} AND vo2max IS NOT NULL
             ORDER BY date DESC LIMIT 1) AS latest_vo2max
          FROM fitness.v_daily_metrics
          WHERE user_id = ${ctx.userId}
            AND date > ${dateWindowStart(endDate, totalDays)}
        ),
        hr_zone_time AS (
          SELECT
            COALESCE(SUM(
              CASE WHEN up3.max_hr IS NOT NULL AND rhr2.resting_hr IS NOT NULL
                   AND asum.hr_sample_count > 0 AND asum.ended_at IS NOT NULL
              THEN
                cnt.aerobic_count::real / asum.hr_sample_count::real
                * EXTRACT(EPOCH FROM (asum.ended_at - asum.started_at)) / 60.0
              ELSE 0 END
            ), 0) AS aerobic_minutes,
            COALESCE(SUM(
              CASE WHEN up3.max_hr IS NOT NULL AND rhr2.resting_hr IS NOT NULL
                   AND asum.hr_sample_count > 0 AND asum.ended_at IS NOT NULL
              THEN
                cnt.hi_count::real / asum.hr_sample_count::real
                * EXTRACT(EPOCH FROM (asum.ended_at - asum.started_at)) / 60.0
              ELSE 0 END
            ), 0) AS high_intensity_minutes
          FROM fitness.activity_summary asum
          JOIN fitness.user_profile up3 ON up3.id = asum.user_id
          JOIN LATERAL (
            SELECT dm2.resting_hr
            FROM fitness.v_daily_metrics dm2
            WHERE dm2.user_id = asum.user_id
              AND dm2.date <= (asum.started_at AT TIME ZONE ${ctx.timezone})::date
              AND dm2.resting_hr IS NOT NULL
            ORDER BY dm2.date DESC LIMIT 1
          ) rhr2 ON true
          JOIN LATERAL (
            SELECT
              COUNT(*) FILTER (WHERE ms2.scalar < rhr2.resting_hr + (up3.max_hr - rhr2.resting_hr) * 0.8) AS aerobic_count,
              COUNT(*) FILTER (WHERE ms2.scalar >= rhr2.resting_hr + (up3.max_hr - rhr2.resting_hr) * 0.8) AS hi_count
            FROM fitness.metric_stream ms2
            WHERE ms2.activity_id = asum.activity_id
              AND ms2.channel = 'heart_rate'
          ) cnt ON true
          WHERE asum.user_id = ${ctx.userId}
            AND asum.started_at > ${timestampWindowStart(endDate, totalDays)}
            AND asum.hr_sample_count > 0
            AND up3.max_hr IS NOT NULL
        ),
        strength_freq AS (
          SELECT NULLIF(COUNT(*), 0)::real / GREATEST(${totalDays}::real / 7, 1) AS sessions_per_week
          FROM fitness.strength_workout
          WHERE user_id = ${ctx.userId}
            AND started_at > ${timestampWindowStart(endDate, totalDays)}
        ),
        body_latest AS (
          SELECT weight_kg, body_fat_pct
          FROM fitness.v_body_measurement
          WHERE user_id = ${ctx.userId}
            AND weight_kg IS NOT NULL
          ORDER BY recorded_at DESC
          LIMIT 1
        ),
        weekly_metrics AS (
          SELECT
            date_trunc('week', date)::date AS week_start,
            AVG(resting_hr) AS avg_rhr,
            AVG(steps) AS avg_steps,
            AVG(vo2max) AS avg_vo2max
          FROM fitness.v_daily_metrics
          WHERE user_id = ${ctx.userId}
            AND date > ${dateWindowStart(endDate, totalDays)}
          GROUP BY date_trunc('week', date)
          ORDER BY week_start ASC
        )
        SELECT
          sa.avg_sleep_min,
          sa.bedtime_stddev_min,
          ma.avg_resting_hr,
          ma.avg_steps,
          ma.latest_vo2max,
          hz.aerobic_minutes / GREATEST(${totalDays}::real / 7, 1) AS weekly_aerobic_min,
          hz.high_intensity_minutes / GREATEST(${totalDays}::real / 7, 1) AS weekly_high_intensity_min,
          sf.sessions_per_week,
          bl.weight_kg,
          bl.body_fat_pct,
          (SELECT json_agg(json_build_object(
            'week_start', wm.week_start::text,
            'avg_rhr', wm.avg_rhr,
            'avg_steps', wm.avg_steps,
            'avg_vo2max', wm.avg_vo2max
          ) ORDER BY wm.week_start ASC) FROM weekly_metrics wm) AS weekly_history
        FROM sleep_agg sa
        CROSS JOIN metrics_agg ma
        CROSS JOIN hr_zone_time hz
        CROSS JOIN strength_freq sf
        LEFT JOIN body_latest bl ON true`,
  );

  return rows[0] ?? null;
}
