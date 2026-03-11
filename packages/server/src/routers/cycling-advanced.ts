import { sql } from "drizzle-orm";
import { z } from "zod";
import { publicProcedure, router } from "../trpc.ts";

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
   * TRIMP = duration_min * avg_hr / max_observed_hr per activity.
   * CTL = 42-day exponentially weighted moving average.
   * Ramp rate = CTL change per week. Safe <5, Aggressive 5-7, Danger >7.
   */
  rampRate: publicProcedure
    .input(daysInput)
    .query(async ({ ctx, input }): Promise<RampRateResult> => {
      // Get max observed HR
      const maxHrResult = await ctx.db.execute(
        sql`SELECT MAX(heart_rate) AS max_hr
            FROM fitness.metric_stream
            WHERE heart_rate IS NOT NULL
              AND activity_id IS NOT NULL`,
      );
      const maxHr = (maxHrResult as unknown as Record<string, unknown>[])[0]?.max_hr as
        | number
        | null;
      if (!maxHr) return { weeks: [], currentRampRate: 0, recommendation: "No data" };

      // Get daily TRIMP loads
      const dailyLoads = await ctx.db.execute(
        sql`SELECT
              a.started_at::date AS day,
              SUM(
                EXTRACT(EPOCH FROM (a.ended_at - a.started_at)) / 60.0
                * sub.avg_hr / ${maxHr}::float
              ) AS trimp
            FROM fitness.v_activity a
            JOIN LATERAL (
              SELECT AVG(ms.heart_rate) AS avg_hr
              FROM fitness.metric_stream ms
              WHERE ms.activity_id = a.id
                AND ms.heart_rate IS NOT NULL
            ) sub ON sub.avg_hr IS NOT NULL AND sub.avg_hr > 0
            WHERE a.started_at > NOW() - (${input.days} + 42)::int * INTERVAL '1 day'
              AND a.ended_at IS NOT NULL
            GROUP BY a.started_at::date
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

      for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
        const key = d.toISOString().slice(0, 10);
        const load = loadMap.get(key) ?? 0;
        ctl = ctl * (1 - alpha) + load * alpha;
        ctlByDate.set(key, ctl);
      }

      // Group into weeks and compute ramp rate
      const ctlEntries = [...ctlByDate.entries()].sort(([a], [b]) => a.localeCompare(b));

      // Filter to only the requested date range (exclude the 42-day warmup)
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - input.days);
      const cutoffStr = cutoffDate.toISOString().slice(0, 10);
      const filtered = ctlEntries.filter(([date]) => date >= cutoffStr);

      // Group by ISO week
      const weekMap = new Map<string, { first: number; last: number }>();
      for (const [dateStr, ctlValue] of filtered) {
        const d = new Date(dateStr);
        // Get Monday of the week
        const dayOfWeek = d.getDay();
        const monday = new Date(d);
        monday.setDate(d.getDate() - ((dayOfWeek + 6) % 7));
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
      for (let i = 1; i < weekKeys.length; i++) {
        const prevWeek = weekMap.get(weekKeys[i - 1]);
        const currWeek = weekMap.get(weekKeys[i]);
        if (!prevWeek || !currWeek) continue;

        const rampRate = Math.round((currWeek.last - prevWeek.last) * 100) / 100;
        weeks.push({
          week: weekKeys[i],
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
   * High monotony (>2.0) with high load = elevated illness/overtraining risk.
   */
  trainingMonotony: publicProcedure
    .input(daysInput)
    .query(async ({ ctx, input }): Promise<TrainingMonotonyWeek[]> => {
      const maxHrResult = await ctx.db.execute(
        sql`SELECT MAX(heart_rate) AS max_hr
            FROM fitness.metric_stream
            WHERE heart_rate IS NOT NULL
              AND activity_id IS NOT NULL`,
      );
      const maxHr = (maxHrResult as unknown as Record<string, unknown>[])[0]?.max_hr as
        | number
        | null;
      if (!maxHr) return [];

      const rows = await ctx.db.execute(
        sql`WITH daily_loads AS (
              SELECT
                a.started_at::date AS day,
                SUM(
                  EXTRACT(EPOCH FROM (a.ended_at - a.started_at)) / 60.0
                  * sub.avg_hr / ${maxHr}::float
                ) AS trimp
              FROM fitness.v_activity a
              JOIN LATERAL (
                SELECT AVG(ms.heart_rate) AS avg_hr
                FROM fitness.metric_stream ms
                WHERE ms.activity_id = a.id
                  AND ms.heart_rate IS NOT NULL
              ) sub ON sub.avg_hr IS NOT NULL AND sub.avg_hr > 0
              WHERE a.started_at > NOW() - ${input.days}::int * INTERVAL '1 day'
                AND a.ended_at IS NOT NULL
              GROUP BY a.started_at::date
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

      return rows.map((r) => ({
        week: String(r.week),
        monotony: Number(r.monotony),
        strain: Number(r.strain),
        weeklyLoad: Number(r.weekly_load),
      }));
    }),

  /**
   * Activity Variability: Normalized Power, Variability Index, Intensity Factor.
   * NP computed from 30s rolling average of power samples.
   * FTP estimated as 95% of best 20-minute power across the date range.
   */
  activityVariability: publicProcedure
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
              WHERE a.started_at > NOW() - ${input.days}::int * INTERVAL '1 day'
                AND ms.power > 0
            )
            SELECT ROUND((MAX(avg_20min) * 0.95)::numeric, 1) AS ftp
            FROM rolling
            WHERE rn >= 1200`,
      );
      const ftp = (ftpResult as unknown as { ftp: number }[])[0]?.ftp ?? null;
      if (!ftp) return [];

      // Get power samples per activity for NP calculation
      const activities = await ctx.db.execute(
        sql`SELECT
              a.id AS activity_id,
              a.started_at::date AS date,
              a.name,
              ROUND(AVG(ms.power)::numeric, 1) AS avg_power
            FROM fitness.v_activity a
            JOIN fitness.metric_stream ms ON ms.activity_id = a.id
            WHERE a.started_at > NOW() - ${input.days}::int * INTERVAL '1 day'
              AND ms.power > 0
            GROUP BY a.id, a.started_at, a.name
            HAVING COUNT(*) >= 60
            ORDER BY a.started_at`,
      );

      const results: ActivityVariabilityRow[] = [];

      for (const activity of activities) {
        // Fetch power samples for this activity
        const samples = await ctx.db.execute(
          sql`SELECT ms.power
              FROM fitness.metric_stream ms
              WHERE ms.activity_id = ${activity.activity_id}::uuid
                AND ms.power > 0
              ORDER BY ms.recorded_at`,
        );

        const powerValues = (samples as unknown as { power: number }[]).map((s) => Number(s.power));
        if (powerValues.length < 30) continue;

        // Compute 30s rolling average
        const rolling: number[] = [];
        let windowSum = 0;
        for (let i = 0; i < powerValues.length; i++) {
          windowSum += powerValues[i];
          if (i >= 30) {
            windowSum -= powerValues[i - 30];
          }
          const windowSize = Math.min(i + 1, 30);
          rolling.push(windowSum / windowSize);
        }

        // NP = 4th root of mean of 4th powers of rolling averages
        let sumFourthPower = 0;
        for (const val of rolling) {
          sumFourthPower += val ** 4;
        }
        const normalizedPower = Math.round((sumFourthPower / rolling.length) ** 0.25 * 10) / 10;
        const averagePower = Number(activity.avg_power);
        const variabilityIndex = Math.round((normalizedPower / averagePower) * 1000) / 1000;
        const intensityFactor = Math.round((normalizedPower / ftp) * 1000) / 1000;

        results.push({
          date: String(activity.date),
          activityName: String(activity.name),
          normalizedPower,
          averagePower,
          variabilityIndex,
          intensityFactor,
        });
      }

      return results;
    }),

  /**
   * Vertical Ascent Rate (VAM) for segments where grade > 3%.
   * VAM = vertical meters gained per hour of climbing.
   */
  verticalAscentRate: publicProcedure
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
              WHERE a.started_at > NOW() - ${input.days}::int * INTERVAL '1 day'
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

      return rows.map((r) => {
        const elevationGainMeters = Number(r.elevation_gain);
        const climbingSeconds = Number(r.climbing_seconds);
        const climbingMinutes = Math.round((climbingSeconds / 60) * 10) / 10;
        const verticalAscentRate =
          climbingSeconds > 0
            ? Math.round((elevationGainMeters / (climbingSeconds / 3600)) * 10) / 10
            : 0;

        return {
          date: String(r.date),
          activityName: String(r.name),
          verticalAscentRate,
          elevationGainMeters,
          climbingMinutes,
        };
      });
    }),

  /**
   * Pedal Dynamics: left/right balance, torque effectiveness, pedal smoothness.
   */
  pedalDynamics: publicProcedure
    .input(daysInput)
    .query(async ({ ctx, input }): Promise<PedalDynamicsRow[]> => {
      const rows = await ctx.db.execute(
        sql`SELECT
              a.started_at::date AS date,
              a.name,
              ROUND(AVG(ms.left_right_balance)::numeric, 1) AS avg_balance,
              ROUND(
                ((AVG(ms.left_torque_effectiveness) + AVG(ms.right_torque_effectiveness)) / 2)::numeric, 1
              ) AS avg_torque_effectiveness,
              ROUND(
                ((AVG(ms.left_pedal_smoothness) + AVG(ms.right_pedal_smoothness)) / 2)::numeric, 1
              ) AS avg_pedal_smoothness
            FROM fitness.v_activity a
            JOIN fitness.metric_stream ms ON ms.activity_id = a.id
            WHERE a.started_at > NOW() - ${input.days}::int * INTERVAL '1 day'
              AND ms.left_right_balance IS NOT NULL
            GROUP BY a.id, a.started_at, a.name
            HAVING COUNT(ms.left_right_balance) >= 60
            ORDER BY a.started_at`,
      );

      return rows.map((r) => ({
        date: String(r.date),
        activityName: String(r.name),
        leftRightBalance: Number(r.avg_balance),
        avgTorqueEffectiveness: Number(r.avg_torque_effectiveness),
        avgPedalSmoothness: Number(r.avg_pedal_smoothness),
      }));
    }),
});
