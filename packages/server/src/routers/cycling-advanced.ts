import { sql } from "drizzle-orm";
import { z } from "zod";
import { enduranceTypeFilter } from "../lib/endurance-types.ts";
import { dateStringSchema, executeWithSchema } from "../lib/typed-sql.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

export interface RampRateWeek {
  week: string;
  ctlStart: number;
  ctlEnd: number;
  rampRate: number;
}

export interface RampRateResult {
  weeks: RampRateWeek[];
  currentRampRate: number;
  recommendation: string;
}

export interface TrainingMonotonyWeek {
  week: string;
  monotony: number;
  strain: number;
  weeklyLoad: number;
}

export interface ActivityVariabilityRow {
  date: string;
  activityName: string;
  normalizedPower: number;
  averagePower: number;
  variabilityIndex: number;
  intensityFactor: number;
}

export interface ActivityVariabilityResult {
  rows: ActivityVariabilityRow[];
  totalCount: number;
}

export interface VerticalAscentRow {
  date: string;
  activityName: string;
  verticalAscentRate: number;
  elevationGainMeters: number;
  climbingMinutes: number;
}

export interface PedalDynamicsRow {
  date: string;
  activityName: string;
  leftRightBalance: number;
  avgTorqueEffectiveness: number;
  avgPedalSmoothness: number;
}

const daysInput = z.object({ days: z.number().default(90) });

export const cyclingAdvancedRouter = router({
  /**
   * Ramp Rate: week-over-week CTL change based on HR TRIMP load.
   * Reads from activity_summary rollup + user_profile.max_hr.
   */
  rampRate: cachedProtectedQuery(CacheTTL.LONG)
    .input(daysInput)
    .query(async ({ ctx, input }): Promise<RampRateResult> => {
      // Get daily TRIMP loads from activity_summary
      const dailyLoadSchema = z.object({
        day: dateStringSchema,
        trimp: z.coerce.number(),
      });
      const dailyLoads = await executeWithSchema(
        ctx.db,
        dailyLoadSchema,
        sql`SELECT
              (asum.started_at AT TIME ZONE ${ctx.timezone})::date AS day,
              SUM(
                CASE WHEN up.max_hr > rhr.val AND asum.avg_hr > rhr.val THEN
                  -- Bannister TRIMP normalized to hrTSS (matches PMC router)
                  EXTRACT(EPOCH FROM (asum.ended_at - asum.started_at)) / 60.0
                  * ((asum.avg_hr - rhr.val)::float / (up.max_hr - rhr.val))
                  * 0.64 * exp(1.92 * ((asum.avg_hr - rhr.val)::float / (up.max_hr - rhr.val)))
                  / (60.0 * 0.85 * 0.64 * exp(1.92 * 0.85))
                  * 100
                ELSE 0 END
              ) AS trimp
            FROM fitness.activity_summary asum
            JOIN fitness.user_profile up ON up.id = asum.user_id
            CROSS JOIN LATERAL (
              SELECT COALESCE(up.resting_hr, (
                SELECT dm.resting_hr FROM fitness.v_daily_metrics dm
                WHERE dm.user_id = up.id AND dm.resting_hr IS NOT NULL
                ORDER BY dm.date DESC LIMIT 1
              ), 60)::float AS val
            ) rhr
            WHERE up.id = ${ctx.userId}
              AND up.max_hr IS NOT NULL
              AND asum.started_at > NOW() - (${input.days} + 42)::int * INTERVAL '1 day'
              AND ${enduranceTypeFilter("asum")}
              AND asum.ended_at IS NOT NULL
              AND asum.avg_hr IS NOT NULL
              AND asum.avg_hr > 0
            GROUP BY (asum.started_at AT TIME ZONE ${ctx.timezone})::date
            ORDER BY day`,
      );

      if (dailyLoads.length === 0)
        return { weeks: [], currentRampRate: 0, recommendation: "No data" };

      // Fill in zero-load days and compute CTL (42-day EWMA)
      const loadMap = new Map<string, number>();
      for (const row of dailyLoads) {
        loadMap.set(row.day, row.trimp);
      }

      const firstLoad = dailyLoads[0];
      const lastLoad = dailyLoads[dailyLoads.length - 1];
      if (!firstLoad || !lastLoad)
        return { weeks: [], currentRampRate: 0, recommendation: "No data" };
      const startDate = new Date(firstLoad.day);
      const endDate = new Date(lastLoad.day);
      const ctlByDate = new Map<string, number>();
      let ctl = 0;

      for (
        let current = new Date(startDate);
        current <= endDate;
        current.setDate(current.getDate() + 1)
      ) {
        const key = current.toISOString().slice(0, 10);
        const load = loadMap.get(key) ?? 0;
        // Banister impulse-response EWMA: alpha = 1/N (matches PMC router)
        ctl = ctl + (load - ctl) / 42;
        ctlByDate.set(key, ctl);
      }

      // Group into weeks and compute ramp rate
      const ctlEntries = [...ctlByDate.entries()].sort(([dateA], [dateB]) =>
        dateA.localeCompare(dateB),
      );

      // Filter to only the requested date range (exclude the 42-day warmup)
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - input.days);
      const cutoffStr = cutoffDate.toISOString().slice(0, 10);
      const filtered = ctlEntries.filter(([dateStr]) => dateStr >= cutoffStr);

      // Group by ISO week
      const weekMap = new Map<string, { first: number; last: number }>();
      for (const [dateStr, ctlValue] of filtered) {
        const dateObj = new Date(dateStr);
        // Get Monday of the week
        const dayOfWeek = dateObj.getDay();
        const monday = new Date(dateObj);
        monday.setDate(dateObj.getDate() - ((dayOfWeek + 6) % 7));
        const weekKey = monday.toISOString().slice(0, 10);

        const existing = weekMap.get(weekKey);
        if (!existing) {
          weekMap.set(weekKey, { first: ctlValue, last: ctlValue });
        } else {
          existing.last = ctlValue;
        }
      }

      const weeks: RampRateWeek[] = [];
      const weekKeys = [...weekMap.keys()].sort();
      for (let idx = 1; idx < weekKeys.length; idx++) {
        const prevKey = weekKeys[idx - 1];
        const currKey = weekKeys[idx];
        if (!prevKey || !currKey) continue;
        const prevWeek = weekMap.get(prevKey);
        const currWeek = weekMap.get(currKey);
        if (!prevWeek || !currWeek) continue;

        const rampRate = Math.round((currWeek.last - prevWeek.last) * 100) / 100;
        weeks.push({
          week: currKey,
          ctlStart: Math.round(prevWeek.last * 100) / 100,
          ctlEnd: Math.round(currWeek.last * 100) / 100,
          rampRate,
        });
      }

      const currentRampRate = weeks.length > 0 ? (weeks[weeks.length - 1]?.rampRate ?? 0) : 0;

      let recommendation: string;
      if (Math.abs(currentRampRate) < 5) {
        recommendation = "Safe: ramp rate is within sustainable range";
      } else if (Math.abs(currentRampRate) <= 7) {
        recommendation = "Aggressive: monitor fatigue closely and ensure recovery";
      } else {
        recommendation = "Danger: ramp rate is too high, risk of overtraining or injury";
      }

      return { weeks, currentRampRate, recommendation };
    }),

  /**
   * Training Monotony: weekly monotony (mean daily load / stdev) and strain.
   * Reads from activity_summary rollup + user_profile.max_hr.
   * High monotony (>2.0) with high load = elevated illness/overtraining risk.
   */
  trainingMonotony: cachedProtectedQuery(CacheTTL.LONG)
    .input(daysInput)
    .query(async ({ ctx, input }): Promise<TrainingMonotonyWeek[]> => {
      const monotonyRowSchema = z.object({
        week: dateStringSchema,
        monotony: z.coerce.number(),
        strain: z.coerce.number(),
        weekly_load: z.coerce.number(),
      });
      const rows = await executeWithSchema(
        ctx.db,
        monotonyRowSchema,
        sql`WITH daily_loads AS (
              SELECT
                (asum.started_at AT TIME ZONE ${ctx.timezone})::date AS day,
                SUM(
                  CASE WHEN up.max_hr > rhr.val AND asum.avg_hr > rhr.val THEN
                    -- Bannister TRIMP normalized to hrTSS (matches PMC router)
                    EXTRACT(EPOCH FROM (asum.ended_at - asum.started_at)) / 60.0
                    * ((asum.avg_hr - rhr.val)::float / (up.max_hr - rhr.val))
                    * 0.64 * exp(1.92 * ((asum.avg_hr - rhr.val)::float / (up.max_hr - rhr.val)))
                    / (60.0 * 0.85 * 0.64 * exp(1.92 * 0.85))
                    * 100
                  ELSE 0 END
                ) AS trimp
              FROM fitness.activity_summary asum
              JOIN fitness.user_profile up ON up.id = asum.user_id
              CROSS JOIN LATERAL (
                SELECT COALESCE(up.resting_hr, (
                  SELECT dm.resting_hr FROM fitness.v_daily_metrics dm
                  WHERE dm.user_id = up.id AND dm.resting_hr IS NOT NULL
                  ORDER BY dm.date DESC LIMIT 1
                ), 60)::float AS val
              ) rhr
              WHERE up.id = ${ctx.userId}
                AND up.max_hr IS NOT NULL
                AND asum.started_at > NOW() - ${input.days}::int * INTERVAL '1 day'
                AND ${enduranceTypeFilter("asum")}
                AND asum.ended_at IS NOT NULL
                AND asum.avg_hr IS NOT NULL
                AND asum.avg_hr > 0
              GROUP BY (asum.started_at AT TIME ZONE ${ctx.timezone})::date
            ),
            weekly_stats AS (
              SELECT
                date_trunc('week', day)::date AS week,
                AVG(trimp) AS mean_load,
                STDDEV_POP(trimp) AS stdev_load,
                SUM(trimp) AS weekly_load
              FROM daily_loads
              GROUP BY date_trunc('week', day)
              HAVING STDDEV_POP(trimp) > 0
            )
            SELECT
              week,
              ROUND((mean_load / stdev_load)::numeric, 2) AS monotony,
              ROUND((weekly_load * (mean_load / stdev_load))::numeric, 1) AS strain,
              ROUND(weekly_load::numeric, 1) AS weekly_load
            FROM weekly_stats
            ORDER BY week`,
      );

      return rows.map((row) => ({
        week: row.week,
        monotony: row.monotony,
        strain: row.strain,
        weeklyLoad: row.weekly_load,
      }));
    }),

  /**
   * Activity Variability: Normalized Power, Variability Index, Intensity Factor.
   * NP computed from 30s rolling average of power samples.
   * MUST hit raw metric_stream for sequential window functions.
   */
  activityVariability: cachedProtectedQuery(CacheTTL.LONG)
    .input(
      z.object({
        days: z.number().default(90),
        limit: z.number().min(1).max(100).default(20),
        offset: z.number().min(0).default(0),
      }),
    )
    .query(async ({ ctx, input }): Promise<ActivityVariabilityResult> => {
      // Estimate FTP as 95% of best 20-minute average power.
      // Includes zero-power samples and adapts row offset to sample interval.
      const ftpSchema = z.object({ ftp: z.coerce.number() });
      const ftpResult = await executeWithSchema(
        ctx.db,
        ftpSchema,
        sql`WITH activity_power AS (
              SELECT
                ms.activity_id,
                ms.recorded_at,
                ROW_NUMBER() OVER (
                  PARTITION BY ms.activity_id ORDER BY ms.recorded_at
                ) AS rn,
                SUM(COALESCE(ms.power, 0)) OVER (
                  PARTITION BY ms.activity_id ORDER BY ms.recorded_at
                  ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                ) AS cumsum
              FROM fitness.metric_stream ms
              JOIN fitness.v_activity a ON a.id = ms.activity_id
              WHERE a.user_id = ${ctx.userId}
                AND a.started_at > NOW() - ${input.days}::int * INTERVAL '1 day'
                AND ms.recorded_at > NOW() - (${input.days} + 1)::int * INTERVAL '1 day'
                AND ${enduranceTypeFilter("a")}
                AND ms.power IS NOT NULL
            ),
            sample_rate AS (
              SELECT activity_id,
                     GREATEST(ROUND(
                       EXTRACT(EPOCH FROM MAX(recorded_at) - MIN(recorded_at))::numeric
                       / NULLIF(COUNT(*) - 1, 0)
                     )::int, 1) AS interval_s
              FROM activity_power
              GROUP BY activity_id
              HAVING COUNT(*) > 1
            )
            SELECT ROUND((MAX((ap.cumsum - prev.cumsum)::numeric / ROUND(1200.0 / sr.interval_s)) * 0.95)::numeric, 1) AS ftp
            FROM activity_power ap
            JOIN sample_rate sr ON sr.activity_id = ap.activity_id
            JOIN activity_power prev
              ON prev.activity_id = ap.activity_id
              AND prev.rn = ap.rn - ROUND(1200.0 / sr.interval_s)::int
            WHERE ap.rn >= ROUND(1200.0 / sr.interval_s)::int`,
      );
      const ftp = ftpResult[0]?.ftp ?? null;
      if (!ftp) return { rows: [], totalCount: 0 };

      // Compute NP, avg power per activity in a single query using SQL window functions
      const variabilityRowSchema = z.object({
        date: dateStringSchema,
        name: z.string(),
        np: z.coerce.number(),
        avg_power: z.coerce.number(),
        total_count: z.coerce.number(),
      });
      const rows = await executeWithSchema(
        ctx.db,
        variabilityRowSchema,
        sql`WITH rolling AS (
              SELECT
                ms.activity_id,
                AVG(ms.power) OVER (
                  PARTITION BY ms.activity_id
                  ORDER BY ms.recorded_at
                  RANGE BETWEEN INTERVAL '29 seconds' PRECEDING AND CURRENT ROW
                ) AS rolling_30s_power
              FROM fitness.metric_stream ms
              JOIN fitness.v_activity a ON a.id = ms.activity_id
              WHERE a.user_id = ${ctx.userId}
                AND a.started_at > NOW() - ${input.days}::int * INTERVAL '1 day'
                AND ms.recorded_at > NOW() - (${input.days} + 1)::int * INTERVAL '1 day'
                AND ${enduranceTypeFilter("a")}
                AND ms.power > 0
            ),
            grouped AS (
              SELECT
                (a.started_at AT TIME ZONE ${ctx.timezone})::date AS date,
                a.name,
                a.started_at,
                ROUND(POWER(AVG(POWER(r.rolling_30s_power, 4)), 0.25)::numeric, 1) AS np,
                ROUND(AVG(r.rolling_30s_power)::numeric, 1) AS avg_power
              FROM rolling r
              JOIN fitness.v_activity a ON a.id = r.activity_id
              GROUP BY a.id, a.started_at, a.name
              HAVING COUNT(*) >= 60
            )
            SELECT date, name, np, avg_power,
                   COUNT(*) OVER()::int AS total_count
            FROM grouped
            ORDER BY started_at DESC
            LIMIT ${input.limit}
            OFFSET ${input.offset}`,
      );

      const totalCount = rows[0]?.total_count ?? 0;

      return {
        rows: rows.map((row) => {
          const normalizedPower = row.np;
          const averagePower = row.avg_power;
          return {
            date: row.date,
            activityName: row.name,
            normalizedPower,
            averagePower,
            variabilityIndex: Math.round((normalizedPower / averagePower) * 1000) / 1000,
            intensityFactor: Math.round((normalizedPower / ftp) * 1000) / 1000,
          };
        }),
        totalCount,
      };
    }),

  /**
   * Vertical Ascent Rate (VAM) for segments where grade > 3%.
   * MUST hit raw metric_stream for LAG() over sequential altitude.
   */
  verticalAscentRate: cachedProtectedQuery(CacheTTL.LONG)
    .input(daysInput)
    .query(async ({ ctx, input }): Promise<VerticalAscentRow[]> => {
      const vamRowSchema = z.object({
        date: dateStringSchema,
        name: z.string(),
        elevation_gain: z.coerce.number(),
        climbing_seconds: z.coerce.number(),
      });
      const rows = await executeWithSchema(
        ctx.db,
        vamRowSchema,
        sql`WITH climbing_segments AS (
              SELECT
                ms.activity_id,
                ms.altitude,
                ms.grade,
                ms.recorded_at,
                LAG(ms.altitude) OVER (
                  PARTITION BY ms.activity_id ORDER BY ms.recorded_at
                ) AS prev_altitude,
                LAG(ms.recorded_at) OVER (
                  PARTITION BY ms.activity_id ORDER BY ms.recorded_at
                ) AS prev_recorded_at
              FROM fitness.metric_stream ms
              JOIN fitness.v_activity a ON a.id = ms.activity_id
              WHERE a.user_id = ${ctx.userId}
                AND a.started_at > NOW() - ${input.days}::int * INTERVAL '1 day'
                AND ms.recorded_at > NOW() - (${input.days} + 1)::int * INTERVAL '1 day'
                AND ${enduranceTypeFilter("a")}
                AND ms.altitude IS NOT NULL
                AND ms.grade IS NOT NULL
                AND ms.grade > 3
            )
            SELECT
              (a.started_at AT TIME ZONE ${ctx.timezone})::date AS date,
              a.name,
              ROUND(SUM(
                GREATEST(cs.altitude - cs.prev_altitude, 0)
              )::numeric, 1) AS elevation_gain,
              SUM(
                EXTRACT(EPOCH FROM (cs.recorded_at - cs.prev_recorded_at))
              )::int AS climbing_seconds
            FROM climbing_segments cs
            JOIN fitness.v_activity a ON a.id = cs.activity_id
            WHERE cs.prev_altitude IS NOT NULL
              AND cs.prev_recorded_at IS NOT NULL
            GROUP BY a.id, a.started_at, a.name
            HAVING SUM(EXTRACT(EPOCH FROM (cs.recorded_at - cs.prev_recorded_at))) > 60
            ORDER BY a.started_at`,
      );

      return rows.map((row) => {
        const elevationGainMeters = row.elevation_gain;
        const climbingSeconds = row.climbing_seconds;
        const climbingMinutes = Math.round((climbingSeconds / 60) * 10) / 10;
        const verticalAscentRate =
          climbingSeconds > 0
            ? Math.round((elevationGainMeters / (climbingSeconds / 3600)) * 10) / 10
            : 0;

        return {
          date: row.date,
          activityName: row.name,
          verticalAscentRate,
          elevationGainMeters,
          climbingMinutes,
        };
      });
    }),

  /**
   * Pedal Dynamics: left/right balance, torque effectiveness, pedal smoothness.
   * Reads from activity_summary rollup view.
   */
  pedalDynamics: cachedProtectedQuery(CacheTTL.LONG)
    .input(daysInput)
    .query(async ({ ctx, input }): Promise<PedalDynamicsRow[]> => {
      const pedalRowSchema = z.object({
        date: dateStringSchema,
        name: z.string(),
        avg_balance: z.coerce.number(),
        avg_torque_effectiveness: z.coerce.number(),
        avg_pedal_smoothness: z.coerce.number(),
      });
      const rows = await executeWithSchema(
        ctx.db,
        pedalRowSchema,
        sql`SELECT
              (asum.started_at AT TIME ZONE ${ctx.timezone})::date AS date,
              asum.name,
              ROUND(asum.avg_left_balance::numeric, 1) AS avg_balance,
              ROUND(
                ((asum.avg_left_torque_eff + asum.avg_right_torque_eff) / 2)::numeric, 1
              ) AS avg_torque_effectiveness,
              ROUND(
                ((asum.avg_left_pedal_smooth + asum.avg_right_pedal_smooth) / 2)::numeric, 1
              ) AS avg_pedal_smoothness
            FROM fitness.activity_summary asum
            WHERE asum.user_id = ${ctx.userId}
              AND asum.started_at > NOW() - ${input.days}::int * INTERVAL '1 day'
              AND ${enduranceTypeFilter("asum")}
              AND asum.avg_left_balance IS NOT NULL
            ORDER BY asum.started_at`,
      );

      return rows.map((row) => ({
        date: row.date,
        activityName: row.name,
        leftRightBalance: row.avg_balance,
        avgTorqueEffectiveness: row.avg_torque_effectiveness,
        avgPedalSmoothness: row.avg_pedal_smoothness,
      }));
    }),
});
