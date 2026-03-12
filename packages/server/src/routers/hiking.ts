import { sql } from "drizzle-orm";
import { z } from "zod";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

export interface GradeAdjustedPaceRow {
  date: string;
  activityName: string;
  activityType: string;
  distanceKm: number;
  durationMinutes: number;
  averagePaceMinPerKm: number;
  gradeAdjustedPaceMinPerKm: number;
  elevationGainMeters: number;
  elevationLossMeters: number;
}

export interface ElevationProfileRow {
  week: string;
  elevationGainMeters: number;
  activityCount: number;
  totalDistanceKm: number;
}

export interface WalkingBiomechanicsRow {
  date: string;
  walkingSpeedKmh: number | null;
  stepLengthCm: number | null;
  doubleSupportPct: number | null;
  asymmetryPct: number | null;
  steadiness: number | null;
}

export interface ActivityComparisonInstance {
  date: string;
  durationMinutes: number;
  averagePaceMinPerKm: number;
  avgHeartRate: number | null;
  elevationGainMeters: number;
}

export interface ActivityComparisonRow {
  activityName: string;
  instances: ActivityComparisonInstance[];
}

export const hikingRouter = router({
  /**
   * Grade-adjusted pace for walking, hiking, and trail running activities.
   * Uses the Minetti cost factor model to normalize pace for grade.
   * Reads from activity_summary rollup view.
   */
  gradeAdjustedPace: cachedProtectedQuery(CacheTTL.LONG)
    .input(z.object({ days: z.number().default(90) }))
    .query(async ({ ctx, input }) => {
      interface SummaryRow {
        date: string;
        activity_name: string;
        activity_type: string;
        total_distance: number;
        duration_seconds: number;
        elevation_gain: number | null;
        elevation_loss: number | null;
      }
      const rows = await ctx.db.execute(
        sql`SELECT
              asum.started_at::date::text AS date,
              asum.name AS activity_name,
              asum.activity_type,
              COALESCE(asum.total_distance, 0)::numeric AS total_distance,
              EXTRACT(EPOCH FROM (asum.ended_at - asum.started_at)) AS duration_seconds,
              asum.elevation_gain,
              asum.elevation_loss
            FROM fitness.activity_summary asum
            WHERE asum.user_id = ${ctx.userId}
              AND asum.started_at > NOW() - ${input.days}::int * INTERVAL '1 day'
              AND asum.activity_type IN ('walking', 'hiking', 'trail_running')
              AND asum.ended_at IS NOT NULL
              AND asum.total_distance > 0
            ORDER BY asum.started_at`,
      );

      return (rows as unknown as SummaryRow[]).map((r) => {
        const distanceKm = Number(r.total_distance) / 1000;
        const durationMinutes = Number(r.duration_seconds) / 60;
        const averagePaceMinPerKm = distanceKm > 0 ? durationMinutes / distanceKm : 0;
        const elevationGain = Number(r.elevation_gain ?? 0);
        const elevationLoss = Number(r.elevation_loss ?? 0);
        const avgGrade =
          Number(r.total_distance) > 0
            ? (elevationGain - elevationLoss) / Number(r.total_distance)
            : 0;

        let costFactor: number;
        if (avgGrade >= 0) {
          costFactor = 1 + avgGrade * 3.5;
        } else {
          costFactor = Math.max(0.5, 1 - Math.abs(avgGrade) * 1.8);
        }

        const gradeAdjustedPaceMinPerKm = averagePaceMinPerKm / costFactor;

        return {
          date: String(r.date),
          activityName: String(r.activity_name),
          activityType: String(r.activity_type),
          distanceKm: Math.round(distanceKm * 100) / 100,
          durationMinutes: Math.round(durationMinutes * 10) / 10,
          averagePaceMinPerKm: Math.round(averagePaceMinPerKm * 100) / 100,
          gradeAdjustedPaceMinPerKm: Math.round(gradeAdjustedPaceMinPerKm * 100) / 100,
          elevationGainMeters: Math.round(elevationGain),
          elevationLossMeters: Math.round(elevationLoss),
        } satisfies GradeAdjustedPaceRow;
      });
    }),

  /**
   * Weekly cumulative elevation gain from hiking and walking activities.
   * Reads from activity_summary rollup view.
   */
  elevationProfile: cachedProtectedQuery(CacheTTL.LONG)
    .input(z.object({ days: z.number().default(365) }))
    .query(async ({ ctx, input }) => {
      interface ElevRow {
        week: string;
        elevation_gain_m: number;
        activity_count: number;
        total_distance_km: number;
      }
      const rows = await ctx.db.execute(
        sql`SELECT
              date_trunc('week', asum.started_at)::date::text AS week,
              ROUND(SUM(COALESCE(asum.elevation_gain, 0))::numeric, 1) AS elevation_gain_m,
              COUNT(*)::int AS activity_count,
              ROUND(SUM(COALESCE(asum.total_distance, 0))::numeric / 1000.0, 2) AS total_distance_km
            FROM fitness.activity_summary asum
            WHERE asum.user_id = ${ctx.userId}
              AND asum.started_at > NOW() - ${input.days}::int * INTERVAL '1 day'
              AND asum.activity_type IN ('walking', 'hiking')
            GROUP BY date_trunc('week', asum.started_at)
            ORDER BY week`,
      );

      return (rows as unknown as ElevRow[]).map((r) => ({
        week: String(r.week),
        elevationGainMeters: Number(r.elevation_gain_m),
        activityCount: Number(r.activity_count),
        totalDistanceKm: Number(r.total_distance_km),
      })) satisfies ElevationProfileRow[];
    }),

  /**
   * Walking biomechanics from daily health metrics.
   */
  walkingBiomechanics: cachedProtectedQuery(CacheTTL.LONG)
    .input(z.object({ days: z.number().default(90) }))
    .query(async ({ ctx, input }) => {
      interface WalkRow {
        date: string;
        walking_speed: number | null;
        step_length: number | null;
        double_support_pct: number | null;
        asymmetry_pct: number | null;
        steadiness: number | null;
      }
      const rows = await ctx.db.execute(
        sql`SELECT
              date::text,
              walking_speed,
              walking_step_length AS step_length,
              walking_double_support_pct AS double_support_pct,
              walking_asymmetry_pct AS asymmetry_pct,
              walking_steadiness AS steadiness
            FROM fitness.daily_metrics
            WHERE user_id = ${ctx.userId}
              AND date > NOW() - ${input.days}::int * INTERVAL '1 day'
              AND (walking_speed IS NOT NULL
                OR walking_step_length IS NOT NULL
                OR walking_double_support_pct IS NOT NULL
                OR walking_asymmetry_pct IS NOT NULL
                OR walking_steadiness IS NOT NULL)
            ORDER BY date`,
      );

      return (rows as unknown as WalkRow[]).map((r) => ({
        date: String(r.date),
        walkingSpeedKmh:
          r.walking_speed != null ? Math.round(Number(r.walking_speed) * 3.6 * 100) / 100 : null,
        stepLengthCm: r.step_length != null ? Number(r.step_length) : null,
        doubleSupportPct: r.double_support_pct != null ? Number(r.double_support_pct) : null,
        asymmetryPct: r.asymmetry_pct != null ? Number(r.asymmetry_pct) : null,
        steadiness: r.steadiness != null ? Number(r.steadiness) : null,
      })) satisfies WalkingBiomechanicsRow[];
    }),

  /**
   * Compare repeated activities (same name, 2+ instances) over time.
   * Reads from activity_summary rollup view.
   */
  activityComparison: cachedProtectedQuery(CacheTTL.LONG)
    .input(z.object({ days: z.number().default(365) }))
    .query(async ({ ctx, input }) => {
      interface CompRow {
        activity_name: string;
        date: string;
        duration_minutes: number;
        average_pace_min_per_km: number;
        avg_heart_rate: number | null;
        elevation_gain_m: number;
      }
      const rows = await ctx.db.execute(
        sql`WITH activity_data AS (
              SELECT
                asum.name AS activity_name,
                asum.started_at::date AS date,
                ROUND((EXTRACT(EPOCH FROM (asum.ended_at - asum.started_at)) / 60.0)::numeric, 1) AS duration_minutes,
                CASE WHEN COALESCE(asum.total_distance, 0) > 0
                  THEN ROUND(
                    ((EXTRACT(EPOCH FROM (asum.ended_at - asum.started_at)) / 60.0)
                     / (asum.total_distance / 1000.0))::numeric, 2
                  )
                  ELSE 0
                END AS average_pace_min_per_km,
                ROUND(asum.avg_hr::numeric, 1) AS avg_heart_rate,
                ROUND(COALESCE(asum.elevation_gain, 0)::numeric, 1) AS elevation_gain_m
              FROM fitness.activity_summary asum
              WHERE asum.user_id = ${ctx.userId}
                AND asum.started_at > NOW() - ${input.days}::int * INTERVAL '1 day'
                AND asum.activity_type IN ('walking', 'hiking', 'trail_running')
                AND asum.name IS NOT NULL
                AND asum.ended_at IS NOT NULL
            ),
            repeated_names AS (
              SELECT activity_name
              FROM activity_data
              GROUP BY activity_name
              HAVING COUNT(*) >= 2
            )
            SELECT
              d.activity_name,
              d.date::text,
              d.duration_minutes,
              d.average_pace_min_per_km,
              d.avg_heart_rate,
              d.elevation_gain_m
            FROM activity_data d
            JOIN repeated_names rn ON rn.activity_name = d.activity_name
            ORDER BY d.activity_name, d.date`,
      );

      const grouped = new Map<string, ActivityComparisonInstance[]>();
      for (const r of rows as unknown as CompRow[]) {
        const name = String(r.activity_name);
        if (!grouped.has(name)) {
          grouped.set(name, []);
        }
        // biome-ignore lint/style/noNonNullAssertion: guaranteed by the has() + set() above
        grouped.get(name)!.push({
          date: String(r.date),
          durationMinutes: Number(r.duration_minutes),
          averagePaceMinPerKm: Number(r.average_pace_min_per_km),
          avgHeartRate: r.avg_heart_rate != null ? Number(r.avg_heart_rate) : null,
          elevationGainMeters: Math.round(Number(r.elevation_gain_m)),
        });
      }

      const result: ActivityComparisonRow[] = [];
      for (const [activityName, instances] of grouped) {
        result.push({ activityName, instances });
      }
      return result;
    }),
});
