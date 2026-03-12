import { sql } from "drizzle-orm";
import { z } from "zod";
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
      const dailyLoads = await ctx.db.execute(
        sql`SELECT
              asum.started_at::date AS day,
              SUM(
                EXTRACT(EPOCH FROM (asum.ended_at - asum.started_at)) / 60.0
                * asum.avg_hr / up.max_hr::float
              ) AS trimp
            FROM fitness.activity_summary asum
            JOIN fitness.user_profile up ON up.id = asum.user_id
            WHERE up.id = ${ctx.userId}
              AND up.max_hr IS NOT NULL
              AND asum.started_at > NOW() - (${input.days} + 42)::int * INTERVAL '1 day'
              AND asum.ended_at IS NOT NULL
              AND asum.avg_hr IS NOT NULL
              AND asum.avg_hr > 0
            GROUP BY asum.started_at::date
            ORDER BY day`,
      );

      if (dailyLoads.length === 0)
        return { weeks: [], currentRampRate: 0, recommendation: "No data" };

      // Fill in zero-load days and compute CTL (42-day EWMA)
      const loadMap = new Map<string, number>();
      for (const row of dailyLoads) {
        loadMap.set(String(row.day), Number(row.trimp));
      }

      const startDate = new Date(String(dailyLoads[0].day));
      const endDate = new Date(String(dailyLoads[dailyLoads.length - 1].day));
      const ctlByDate = new Map<string, number>();
      const alpha = 2 / (42 + 1);
      let ctl = 0;

      for (
        let current = new Date(startDate);
        current <= endDate;
        current.setDate(current.getDate() + 1)
      ) {
        const key = current.toISOString().slice(0, 10);
        const load = loadMap.get(key) ?? 0;
        ctl = ctl * (1 - alpha) + load * alpha;
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
        const prevWeek = weekMap.get(weekKeys[idx - 1]);
        const currWeek = weekMap.get(weekKeys[idx]);
        if (!prevWeek || !currWeek) continue;

        const rampRate = Math.round((currWeek.last - prevWeek.last) * 100) / 100;
        weeks.push({
          week: weekKeys[idx],
          ctlStart: Math.round(prevWeek.last * 100) / 100,
          ctlEnd: Math.round(currWeek.last * 100) / 100,
          rampRate,
        });
      }

      const currentRampRate = weeks.length > 0 ? weeks[weeks.length - 1].rampRate : 0;

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
      const rows = await ctx.db.execute(
        sql`WITH daily_loads AS (
              SELECT
                asum.started_at::date AS day,
                SUM(
                  EXTRACT(EPOCH FROM (asum.ended_at - asum.started_at)) / 60.0
                  * asum.avg_hr / up.max_hr::float
                ) AS trimp
              FROM fitness.activity_summary asum
              JOIN fitness.user_profile up ON up.id = asum.user_id
              WHERE up.id = ${ctx.userId}
                AND up.max_hr IS NOT NULL
                AND asum.started_at > NOW() - ${input.days}::int * INTERVAL '1 day'
                AND asum.ended_at IS NOT NULL
                AND asum.avg_hr IS NOT NULL
                AND asum.avg_hr > 0
              GROUP BY asum.started_at::date
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
        week: String(row.week),
        monotony: Number(row.monotony),
        strain: Number(row.strain),
        weeklyLoad: Number(row.weekly_load),
      }));
    }),

  /**
   * Activity Variability: Normalized Power, Variability Index, Intensity Factor.
   * NP computed from 30s rolling average of power samples.
   * MUST hit raw metric_stream for sequential window functions.
   */
  activityVariability: cachedProtectedQuery(CacheTTL.LONG)
    .input(daysInput)
    .query(async ({ ctx, input }): Promise<ActivityVariabilityRow[]> => {
      // Estimate FTP as 95% of best 20-minute average power
      const ftpResult = await ctx.db.execute(
        sql`WITH rolling AS (
              SELECT
                ms.activity_id,
                AVG(ms.power) OVER (
                  PARTITION BY ms.activity_id
                  ORDER BY ms.recorded_at
                  ROWS BETWEEN 1199 PRECEDING AND CURRENT ROW
                ) AS avg_20min,
                ROW_NUMBER() OVER (
                  PARTITION BY ms.activity_id
                  ORDER BY ms.recorded_at
                ) AS rn
              FROM fitness.metric_stream ms
              JOIN fitness.v_activity a ON a.id = ms.activity_id
              WHERE a.user_id = ${ctx.userId}
                AND a.started_at > NOW() - ${input.days}::int * INTERVAL '1 day'
                AND ms.power > 0
            )
            SELECT ROUND((MAX(avg_20min) * 0.95)::numeric, 1) AS ftp
            FROM rolling
            WHERE rn >= 1200`,
      );
      const ftp = (ftpResult as unknown as { ftp: number }[])[0]?.ftp ?? null;
      if (!ftp) return [];

      // Compute NP, avg power per activity in a single query using SQL window functions
      const rows = await ctx.db.execute(
        sql`WITH rolling AS (
              SELECT
                ms.activity_id,
                AVG(ms.power) OVER (
                  PARTITION BY ms.activity_id
                  ORDER BY ms.recorded_at
                  ROWS BETWEEN 29 PRECEDING AND CURRENT ROW
                ) AS rolling_30s_power
              FROM fitness.metric_stream ms
              JOIN fitness.v_activity a ON a.id = ms.activity_id
              WHERE a.user_id = ${ctx.userId}
                AND a.started_at > NOW() - ${input.days}::int * INTERVAL '1 day'
                AND ms.power > 0
            )
            SELECT
              a.started_at::date AS date,
              a.name,
              ROUND(POWER(AVG(POWER(r.rolling_30s_power, 4)), 0.25)::numeric, 1) AS np,
              ROUND(AVG(r.rolling_30s_power)::numeric, 1) AS avg_power
            FROM rolling r
            JOIN fitness.v_activity a ON a.id = r.activity_id
            GROUP BY a.id, a.started_at, a.name
            HAVING COUNT(*) >= 60
            ORDER BY a.started_at`,
      );

      return rows.map((row) => {
        const normalizedPower = Number(row.np);
        const averagePower = Number(row.avg_power);
        return {
          date: String(row.date),
          activityName: String(row.name),
          normalizedPower,
          averagePower,
          variabilityIndex: Math.round((normalizedPower / averagePower) * 1000) / 1000,
          intensityFactor: Math.round((normalizedPower / ftp) * 1000) / 1000,
        };
      });
    }),

  /**
   * Vertical Ascent Rate (VAM) for segments where grade > 3%.
   * MUST hit raw metric_stream for LAG() over sequential altitude.
   */
  verticalAscentRate: cachedProtectedQuery(CacheTTL.LONG)
    .input(daysInput)
    .query(async ({ ctx, input }): Promise<VerticalAscentRow[]> => {
      const rows = await ctx.db.execute(
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
                AND ms.altitude IS NOT NULL
                AND ms.grade IS NOT NULL
                AND ms.grade > 3
            )
            SELECT
              a.started_at::date AS date,
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
        const elevationGainMeters = Number(row.elevation_gain);
        const climbingSeconds = Number(row.climbing_seconds);
        const climbingMinutes = Math.round((climbingSeconds / 60) * 10) / 10;
        const verticalAscentRate =
          climbingSeconds > 0
            ? Math.round((elevationGainMeters / (climbingSeconds / 3600)) * 10) / 10
            : 0;

        return {
          date: String(row.date),
          activityName: String(row.name),
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
      const rows = await ctx.db.execute(
        sql`SELECT
              asum.started_at::date AS date,
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
              AND asum.avg_left_balance IS NOT NULL
            ORDER BY asum.started_at`,
      );

      return rows.map((row) => ({
        date: String(row.date),
        activityName: String(row.name),
        leftRightBalance: Number(row.avg_balance),
        avgTorqueEffectiveness: Number(row.avg_torque_effectiveness),
        avgPedalSmoothness: Number(row.avg_pedal_smoothness),
      }));
    }),
});
