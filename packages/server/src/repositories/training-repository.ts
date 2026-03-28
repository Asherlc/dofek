import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { ZONE_BOUNDARIES_HRR } from "@dofek/zones/zones";
import {
  dateWindowEnd,
  dateWindowStart,
  timestampWindowStart,
} from "../lib/date-window.ts";
import { enduranceTypeFilter } from "../lib/endurance-types.ts";
import { dateStringSchema, executeWithSchema } from "../lib/typed-sql.ts";

// ---------------------------------------------------------------------------
// Zod schemas for DB rows
// ---------------------------------------------------------------------------

const weeklyVolumeRowSchema = z.object({
  week: dateStringSchema,
  activity_type: z.string(),
  count: z.number(),
  hours: z.coerce.number(),
});

export type WeeklyVolumeRow = z.infer<typeof weeklyVolumeRowSchema>;

const hrZoneRowSchema = z.object({
  max_hr: z.number().nullable(),
  week: dateStringSchema,
  zone1: z.coerce.number(),
  zone2: z.coerce.number(),
  zone3: z.coerce.number(),
  zone4: z.coerce.number(),
  zone5: z.coerce.number(),
});

export type HrZoneRow = z.infer<typeof hrZoneRowSchema>;

const activityStatsRowSchema = z.object({
  id: z.string(),
  activity_type: z.string(),
  name: z.string().nullable(),
  started_at: z.string(),
  ended_at: z.string().nullable(),
  avg_hr: z.coerce.number().nullable(),
  max_hr: z.coerce.number().nullable(),
  avg_power: z.coerce.number().nullable(),
  max_power: z.coerce.number().nullable(),
  avg_cadence: z.coerce.number().nullable(),
  hr_samples: z.coerce.number().nullable(),
  power_samples: z.coerce.number().nullable(),
});

export type ActivityStatsRow = z.infer<typeof activityStatsRowSchema>;

const readinessMetricSchema = z.object({
  date: dateStringSchema,
  hrv: z.coerce.number().nullable(),
  resting_hr: z.coerce.number().nullable(),
  respiratory_rate: z.coerce.number().nullable(),
  hrv_mean_30d: z.coerce.number().nullable(),
  hrv_sd_30d: z.coerce.number().nullable(),
  rhr_mean_30d: z.coerce.number().nullable(),
  rhr_sd_30d: z.coerce.number().nullable(),
  rr_mean_30d: z.coerce.number().nullable(),
  rr_sd_30d: z.coerce.number().nullable(),
});

export type ReadinessMetricRow = z.infer<typeof readinessMetricSchema>;

const sleepRowSchema = z.object({
  efficiency_pct: z.coerce.number().nullable(),
});

const acwrRowSchema = z.object({
  acwr: z.coerce.number().nullable(),
});

const muscleFreshnessSchema = z.object({
  muscle_group: z.string(),
  last_trained_date: dateStringSchema,
});

export type MuscleFreshnessRow = z.infer<typeof muscleFreshnessSchema>;

const balanceSchema = z.object({
  strength_7d: z.coerce.number(),
  endurance_7d: z.coerce.number(),
  last_strength_date: dateStringSchema.nullable(),
  last_endurance_date: dateStringSchema.nullable(),
});

export type BalanceRow = z.infer<typeof balanceSchema>;

const zoneTotalsSchema = z.object({
  zone1: z.coerce.number(),
  zone2: z.coerce.number(),
  zone3: z.coerce.number(),
  zone4: z.coerce.number(),
  zone5: z.coerce.number(),
});

export type ZoneTotalsRow = z.infer<typeof zoneTotalsSchema>;

const hiitLoadSchema = z.object({
  hiit_count_7d: z.coerce.number(),
  last_hiit_date: dateStringSchema.nullable(),
});

export type HiitLoadRow = z.infer<typeof hiitLoadSchema>;

const trainingDaySchema = z.object({
  training_date: dateStringSchema,
});

// ---------------------------------------------------------------------------
// Data bundle returned by getNextWorkoutData
// ---------------------------------------------------------------------------

export interface NextWorkoutData {
  latestMetric: ReadinessMetricRow | null;
  latestSleepEfficiency: number | null;
  acwr: number | null;
  muscleFreshness: MuscleFreshnessRow[];
  balance: BalanceRow;
  zoneTotals: ZoneTotalsRow;
  hiitLoad: HiitLoadRow;
  trainingDates: string[];
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export class TrainingRepository {
  readonly #db: Pick<Database, "execute">;
  readonly #userId: string;
  readonly #timezone: string;

  constructor(db: Pick<Database, "execute">, userId: string, timezone: string) {
    this.#db = db;
    this.#userId = userId;
    this.#timezone = timezone;
  }

  /** Weekly training volume grouped by activity type. */
  async getWeeklyVolume(days: number): Promise<WeeklyVolumeRow[]> {
    return executeWithSchema(
      this.#db,
      weeklyVolumeRowSchema,
      sql`SELECT
            date_trunc('week', (started_at AT TIME ZONE ${this.#timezone})::date)::date AS week,
            activity_type,
            COUNT(*)::int AS count,
            ROUND(SUM(EXTRACT(EPOCH FROM (ended_at - started_at)) / 3600)::numeric, 2) AS hours
          FROM fitness.v_activity
          WHERE user_id = ${this.#userId}
            AND started_at > NOW() - ${days}::int * INTERVAL '1 day'
            AND ended_at IS NOT NULL
          GROUP BY 1, activity_type
          ORDER BY week`,
    );
  }

  /** HR zone distribution per week using 5-zone Karvonen model. */
  async getHrZones(days: number): Promise<{ maxHr: number | null; weeks: HrZoneRow[] }> {
    const rows = await executeWithSchema(
      this.#db,
      hrZoneRowSchema,
      sql`SELECT
            up.max_hr,
            date_trunc('week', (a.started_at AT TIME ZONE ${this.#timezone})::date)::date AS week,
            COUNT(*) FILTER (WHERE ms.heart_rate < rhr.resting_hr + (up.max_hr - rhr.resting_hr) * ${ZONE_BOUNDARIES_HRR[0]}::numeric)::int AS zone1,
            COUNT(*) FILTER (WHERE ms.heart_rate >= rhr.resting_hr + (up.max_hr - rhr.resting_hr) * ${ZONE_BOUNDARIES_HRR[0]}::numeric
                              AND ms.heart_rate <  rhr.resting_hr + (up.max_hr - rhr.resting_hr) * ${ZONE_BOUNDARIES_HRR[1]}::numeric)::int AS zone2,
            COUNT(*) FILTER (WHERE ms.heart_rate >= rhr.resting_hr + (up.max_hr - rhr.resting_hr) * ${ZONE_BOUNDARIES_HRR[1]}::numeric
                              AND ms.heart_rate <  rhr.resting_hr + (up.max_hr - rhr.resting_hr) * ${ZONE_BOUNDARIES_HRR[2]}::numeric)::int AS zone3,
            COUNT(*) FILTER (WHERE ms.heart_rate >= rhr.resting_hr + (up.max_hr - rhr.resting_hr) * ${ZONE_BOUNDARIES_HRR[2]}::numeric
                              AND ms.heart_rate <  rhr.resting_hr + (up.max_hr - rhr.resting_hr) * ${ZONE_BOUNDARIES_HRR[3]}::numeric)::int AS zone4,
            COUNT(*) FILTER (WHERE ms.heart_rate >= rhr.resting_hr + (up.max_hr - rhr.resting_hr) * ${ZONE_BOUNDARIES_HRR[3]}::numeric)::int AS zone5
          FROM fitness.user_profile up
          JOIN fitness.v_activity a ON a.user_id = up.id
          JOIN fitness.metric_stream ms ON ms.activity_id = a.id
          JOIN LATERAL (
            SELECT dm.resting_hr
            FROM fitness.v_daily_metrics dm
            WHERE dm.user_id = up.id
              AND dm.date <= (a.started_at AT TIME ZONE ${this.#timezone})::date
              AND dm.resting_hr IS NOT NULL
            ORDER BY dm.date DESC
            LIMIT 1
          ) rhr ON true
          WHERE up.id = ${this.#userId}
            AND a.started_at > NOW() - ${days}::int * INTERVAL '1 day'
            AND ms.recorded_at > NOW() - (${days} + 1)::int * INTERVAL '1 day'
            AND ${enduranceTypeFilter("a")}
            AND up.max_hr IS NOT NULL
            AND ms.heart_rate IS NOT NULL
          GROUP BY up.max_hr, 2
          ORDER BY week`,
    );
    const rawMaxHr = rows[0]?.max_hr;
    const maxHr = typeof rawMaxHr === "number" ? rawMaxHr : null;
    if (!maxHr) return { maxHr: null, weeks: [] };
    return { maxHr, weeks: rows };
  }

  /** Per-activity summary with HR and power stats. */
  async getActivityStats(days: number): Promise<ActivityStatsRow[]> {
    return executeWithSchema(
      this.#db,
      activityStatsRowSchema,
      sql`SELECT
            asum.activity_id AS id,
            asum.activity_type,
            asum.name,
            asum.started_at,
            asum.ended_at,
            ROUND(asum.avg_hr::numeric, 1) AS avg_hr,
            asum.max_hr,
            ROUND(asum.avg_power::numeric, 1) AS avg_power,
            asum.max_power,
            ROUND(asum.avg_cadence::numeric, 1) AS avg_cadence,
            asum.hr_sample_count AS hr_samples,
            asum.power_sample_count AS power_samples
          FROM fitness.activity_summary asum
          WHERE asum.user_id = ${this.#userId}
            AND asum.started_at > NOW() - ${days}::int * INTERVAL '1 day'
          ORDER BY asum.started_at DESC`,
    );
  }

  /** Fetch all raw data needed for the nextWorkout recommendation. */
  async getNextWorkoutData(endDate: string): Promise<NextWorkoutData> {
    const [
      latestMetrics,
      sleepRows,
      acwrRows,
      muscleFreshnessRows,
      balanceRows,
      zoneTotalsRows,
      hiitLoadRows,
      trainingDays,
    ] = await Promise.all([
      this.#fetchLatestMetrics(),
      this.#fetchLatestSleepEfficiency(),
      this.#fetchAcwr(endDate),
      this.#fetchMuscleFreshness(),
      this.#fetchBalance(endDate),
      this.#fetchZoneTotals(endDate),
      this.#fetchHiitLoad(endDate),
      this.#fetchTrainingDays(endDate),
    ]);

    return {
      latestMetric: latestMetrics[0] ?? null,
      latestSleepEfficiency: sleepRows[0]?.efficiency_pct ?? null,
      acwr: acwrRows[0]?.acwr ?? null,
      muscleFreshness: muscleFreshnessRows,
      balance: balanceRows[0] ?? {
        strength_7d: 0,
        endurance_7d: 0,
        last_strength_date: null,
        last_endurance_date: null,
      },
      zoneTotals: zoneTotalsRows[0] ?? { zone1: 0, zone2: 0, zone3: 0, zone4: 0, zone5: 0 },
      hiitLoad: hiitLoadRows[0] ?? { hiit_count_7d: 0, last_hiit_date: null },
      trainingDates: trainingDays.map((d) => d.training_date),
    };
  }

  async #fetchLatestMetrics(): Promise<ReadinessMetricRow[]> {
    return executeWithSchema(
      this.#db,
      readinessMetricSchema,
      sql`WITH latest AS (
          SELECT
            date,
            hrv,
            resting_hr,
            respiratory_rate_avg AS respiratory_rate
          FROM fitness.v_daily_metrics
          WHERE user_id = ${this.#userId}
          ORDER BY date DESC
          LIMIT 1
        )
        SELECT
          latest.date::text AS date,
          latest.hrv,
          latest.resting_hr,
          latest.respiratory_rate,
          baseline.hrv_mean_30d,
          baseline.hrv_sd_30d,
          baseline.rhr_mean_30d,
          baseline.rhr_sd_30d,
          baseline.rr_mean_30d,
          baseline.rr_sd_30d
        FROM latest
        CROSS JOIN LATERAL (
          SELECT
            AVG(dm.hrv) AS hrv_mean_30d,
            STDDEV_POP(dm.hrv) AS hrv_sd_30d,
            AVG(dm.resting_hr) AS rhr_mean_30d,
            STDDEV_POP(dm.resting_hr) AS rhr_sd_30d,
            AVG(dm.respiratory_rate_avg) AS rr_mean_30d,
            STDDEV_POP(dm.respiratory_rate_avg) AS rr_sd_30d
          FROM fitness.v_daily_metrics dm
          WHERE dm.user_id = ${this.#userId}
            AND dm.date BETWEEN latest.date - 29 AND latest.date
        ) baseline`,
    );
  }

  async #fetchLatestSleepEfficiency(): Promise<z.infer<typeof sleepRowSchema>[]> {
    return executeWithSchema(
      this.#db,
      sleepRowSchema,
      sql`SELECT efficiency_pct
        FROM fitness.v_sleep
        WHERE user_id = ${this.#userId}
          AND is_nap = false
        ORDER BY COALESCE(ended_at, started_at + interval '8 hours') DESC
        LIMIT 1`,
    );
  }

  async #fetchAcwr(endDate: string): Promise<z.infer<typeof acwrRowSchema>[]> {
    return executeWithSchema(
      this.#db,
      acwrRowSchema,
      sql`WITH date_series AS (
          SELECT generate_series(
            ${dateWindowStart(endDate, 28)},
            ${dateWindowEnd(endDate)},
            '1 day'::interval
          )::date AS date
        ),
        per_activity AS (
          SELECT
            (asum.started_at AT TIME ZONE ${this.#timezone})::date AS date,
            EXTRACT(EPOCH FROM (asum.ended_at - asum.started_at)) / 60.0
              * asum.avg_hr
              / NULLIF(asum.max_hr, 0) AS load
          FROM fitness.activity_summary asum
          WHERE asum.user_id = ${this.#userId}
            AND (asum.started_at AT TIME ZONE ${this.#timezone})::date >= ${dateWindowStart(endDate, 28)}
            AND asum.ended_at IS NOT NULL
            AND asum.avg_hr IS NOT NULL
        ),
        activity_load AS (
          SELECT date, SUM(load) AS daily_load
          FROM per_activity
          GROUP BY date
        ),
        daily AS (
          SELECT
            ds.date,
            COALESCE(al.daily_load, 0) AS daily_load
          FROM date_series ds
          LEFT JOIN activity_load al ON al.date = ds.date
        ),
        with_windows AS (
          SELECT
            date,
            daily_load,
            SUM(daily_load) OVER (ORDER BY date ROWS BETWEEN 6 PRECEDING AND CURRENT ROW) AS acute_load,
            AVG(daily_load) OVER (ORDER BY date ROWS BETWEEN 27 PRECEDING AND CURRENT ROW) AS chronic_load_avg
          FROM daily
        )
        SELECT
          CASE
            WHEN chronic_load_avg > 0
            THEN acute_load / (chronic_load_avg * 7)
            ELSE NULL
          END AS acwr
        FROM with_windows
        ORDER BY date DESC
        LIMIT 1`,
    );
  }

  async #fetchMuscleFreshness(): Promise<MuscleFreshnessRow[]> {
    return executeWithSchema(
      this.#db,
      muscleFreshnessSchema,
      sql`SELECT
          e.muscle_group,
          MAX((sw.started_at AT TIME ZONE ${this.#timezone})::date)::text AS last_trained_date
        FROM fitness.strength_set ss
        JOIN fitness.strength_workout sw ON sw.id = ss.workout_id
        JOIN fitness.exercise e ON e.id = ss.exercise_id
        WHERE sw.user_id = ${this.#userId}
          AND e.muscle_group IS NOT NULL
        GROUP BY e.muscle_group`,
    );
  }

  async #fetchBalance(endDate: string): Promise<BalanceRow[]> {
    return executeWithSchema(
      this.#db,
      balanceSchema,
      sql`WITH strength_data AS (
          SELECT
            COUNT(*) FILTER (WHERE started_at > ${timestampWindowStart(endDate, 7)})::int AS strength_7d,
            MAX((started_at AT TIME ZONE ${this.#timezone})::date)::text AS last_strength_date
          FROM fitness.strength_workout
          WHERE user_id = ${this.#userId}
        ),
        endurance_data AS (
          SELECT
            COUNT(*) FILTER (WHERE started_at > ${timestampWindowStart(endDate, 7)})::int AS endurance_7d,
            MAX((started_at AT TIME ZONE ${this.#timezone})::date)::text AS last_endurance_date
          FROM fitness.v_activity
          WHERE user_id = ${this.#userId}
            AND ${enduranceTypeFilter("v_activity")}
        )
        SELECT
          s.strength_7d,
          e.endurance_7d,
          s.last_strength_date,
          e.last_endurance_date
        FROM strength_data s
        CROSS JOIN endurance_data e`,
    );
  }

  async #fetchZoneTotals(endDate: string): Promise<ZoneTotalsRow[]> {
    return executeWithSchema(
      this.#db,
      zoneTotalsSchema,
      sql`SELECT
          COUNT(*) FILTER (WHERE ms.heart_rate < rhr.resting_hr + (up.max_hr - rhr.resting_hr) * ${ZONE_BOUNDARIES_HRR[0]}::numeric)::int AS zone1,
          COUNT(*) FILTER (WHERE ms.heart_rate >= rhr.resting_hr + (up.max_hr - rhr.resting_hr) * ${ZONE_BOUNDARIES_HRR[0]}::numeric
                            AND ms.heart_rate <  rhr.resting_hr + (up.max_hr - rhr.resting_hr) * ${ZONE_BOUNDARIES_HRR[1]}::numeric)::int AS zone2,
          COUNT(*) FILTER (WHERE ms.heart_rate >= rhr.resting_hr + (up.max_hr - rhr.resting_hr) * ${ZONE_BOUNDARIES_HRR[1]}::numeric
                            AND ms.heart_rate <  rhr.resting_hr + (up.max_hr - rhr.resting_hr) * ${ZONE_BOUNDARIES_HRR[2]}::numeric)::int AS zone3,
          COUNT(*) FILTER (WHERE ms.heart_rate >= rhr.resting_hr + (up.max_hr - rhr.resting_hr) * ${ZONE_BOUNDARIES_HRR[2]}::numeric
                            AND ms.heart_rate <  rhr.resting_hr + (up.max_hr - rhr.resting_hr) * ${ZONE_BOUNDARIES_HRR[3]}::numeric)::int AS zone4,
          COUNT(*) FILTER (WHERE ms.heart_rate >= rhr.resting_hr + (up.max_hr - rhr.resting_hr) * ${ZONE_BOUNDARIES_HRR[3]}::numeric)::int AS zone5
        FROM fitness.user_profile up
        JOIN fitness.v_activity a ON a.user_id = up.id
        JOIN fitness.metric_stream ms ON ms.activity_id = a.id
        JOIN LATERAL (
          SELECT dm.resting_hr
          FROM fitness.v_daily_metrics dm
          WHERE dm.user_id = up.id
            AND dm.date <= (a.started_at AT TIME ZONE ${this.#timezone})::date
            AND dm.resting_hr IS NOT NULL
          ORDER BY dm.date DESC
          LIMIT 1
        ) rhr ON true
        WHERE up.id = ${this.#userId}
          AND a.started_at > ${timestampWindowStart(endDate, 14)}
          AND ms.recorded_at > ${timestampWindowStart(endDate, 15)}
          AND ${enduranceTypeFilter("a")}
          AND up.max_hr IS NOT NULL
          AND ms.heart_rate IS NOT NULL`,
    );
  }

  async #fetchHiitLoad(endDate: string): Promise<HiitLoadRow[]> {
    return executeWithSchema(
      this.#db,
      hiitLoadSchema,
      sql`WITH per_activity AS (
          SELECT
            a.id,
            (a.started_at AT TIME ZONE ${this.#timezone})::date AS activity_date,
            BOOL_OR(ms.heart_rate >= rhr.resting_hr + (up.max_hr - rhr.resting_hr) * ${ZONE_BOUNDARIES_HRR[2]}::numeric) AS had_high_intensity
          FROM fitness.user_profile up
          JOIN fitness.v_activity a ON a.user_id = up.id
          JOIN fitness.metric_stream ms ON ms.activity_id = a.id
          JOIN LATERAL (
            SELECT dm.resting_hr
            FROM fitness.v_daily_metrics dm
            WHERE dm.user_id = up.id
              AND dm.date <= (a.started_at AT TIME ZONE ${this.#timezone})::date
              AND dm.resting_hr IS NOT NULL
            ORDER BY dm.date DESC
            LIMIT 1
          ) rhr ON true
          WHERE up.id = ${this.#userId}
            AND a.started_at > ${timestampWindowStart(endDate, 21)}
            AND ${enduranceTypeFilter("a")}
            AND up.max_hr IS NOT NULL
            AND ms.heart_rate IS NOT NULL
          GROUP BY a.id, 2
        )
        SELECT
          SUM(
            CASE
              WHEN had_high_intensity
                AND activity_date > ${dateWindowStart(endDate, 7)}
              THEN 1
              ELSE 0
            END
          )::int AS hiit_count_7d,
          MAX(
            CASE
              WHEN had_high_intensity THEN activity_date
              ELSE NULL
            END
          )::text AS last_hiit_date
        FROM per_activity`,
    );
  }

  async #fetchTrainingDays(endDate: string): Promise<z.infer<typeof trainingDaySchema>[]> {
    return executeWithSchema(
      this.#db,
      trainingDaySchema,
      sql`WITH combined AS (
          SELECT DISTINCT (started_at AT TIME ZONE ${this.#timezone})::date AS training_date
          FROM fitness.v_activity
          WHERE user_id = ${this.#userId}
            AND started_at > ${timestampWindowStart(endDate, 14)}
          UNION
          SELECT DISTINCT (started_at AT TIME ZONE ${this.#timezone})::date AS training_date
          FROM fitness.strength_workout
          WHERE user_id = ${this.#userId}
            AND started_at > ${timestampWindowStart(endDate, 14)}
        )
        SELECT training_date::text
        FROM combined
        ORDER BY training_date DESC`,
    );
  }
}
