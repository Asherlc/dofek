import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema } from "../lib/typed-sql.ts";
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
   * Reads from pre-computed activity_summary rollup view.
   */
  gradeAdjustedPace: cachedProtectedQuery(CacheTTL.LONG)
    .input(z.object({ days: z.number().default(90) }))
    .query(async ({ ctx, input }) => {
      const gradeRowSchema = z.object({
        date: z.string(),
        activity_name: z.string(),
        activity_type: z.string(),
        distance_m: z.coerce.number(),
        duration_seconds: z.coerce.number(),
        elevation_gain_m: z.coerce.number(),
        elevation_loss_m: z.coerce.number(),
        avg_grade: z.coerce.number(),
      });
      const rows = await executeWithSchema(
        ctx.db,
        gradeRowSchema,
        sql`SELECT
              a.started_at::date::text AS date,
              a.name AS activity_name,
              a.activity_type,
              ROUND(asum.total_distance::numeric, 1) AS distance_m,
              ROUND(EXTRACT(EPOCH FROM (a.ended_at - a.started_at))::numeric, 1) AS duration_seconds,
              ROUND(asum.elevation_gain_m::numeric, 1) AS elevation_gain_m,
              ROUND(asum.elevation_loss_m::numeric, 1) AS elevation_loss_m,
              CASE WHEN asum.total_distance > 0
                THEN ROUND(((asum.elevation_gain_m - asum.elevation_loss_m) / asum.total_distance * 100)::numeric, 4)
                ELSE 0
              END AS avg_grade
            FROM fitness.v_activity a
            JOIN fitness.activity_summary asum ON asum.activity_id = a.id
            WHERE a.user_id = ${ctx.userId}
              AND a.started_at > NOW() - ${input.days}::int * INTERVAL '1 day'
              AND a.activity_type IN ('walking', 'hiking', 'trail_running')
              AND asum.total_distance > 0
              AND EXTRACT(EPOCH FROM (a.ended_at - a.started_at)) > 0
            ORDER BY a.started_at`,
      );

      return rows.map((r) => {
        const distanceKm = Number(r.distance_m) / 1000;
        const durationMinutes = Number(r.duration_seconds) / 60;
        const averagePaceMinPerKm = distanceKm > 0 ? durationMinutes / distanceKm : 0;
        const avgGrade = Number(r.avg_grade) / 100;

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
          elevationGainMeters: Math.round(Number(r.elevation_gain_m)),
          elevationLossMeters: Math.round(Number(r.elevation_loss_m)),
        } satisfies GradeAdjustedPaceRow;
      });
    }),

  /**
   * Weekly cumulative elevation gain from hiking and walking activities.
   * Reads from pre-computed activity_summary rollup view.
   */
  elevationProfile: cachedProtectedQuery(CacheTTL.LONG)
    .input(z.object({ days: z.number().default(365) }))
    .query(async ({ ctx, input }) => {
      const elevRowSchema = z.object({
        week: z.string(),
        elevation_gain_m: z.coerce.number(),
        activity_count: z.coerce.number(),
        total_distance_km: z.coerce.number(),
      });
      const rows = await executeWithSchema(
        ctx.db,
        elevRowSchema,
        sql`SELECT
              date_trunc('week', a.started_at)::date::text AS week,
              ROUND(SUM(asum.elevation_gain_m)::numeric, 1) AS elevation_gain_m,
              COUNT(*)::int AS activity_count,
              ROUND(SUM(asum.total_distance / 1000.0)::numeric, 2) AS total_distance_km
            FROM fitness.v_activity a
            JOIN fitness.activity_summary asum ON asum.activity_id = a.id
            WHERE a.user_id = ${ctx.userId}
              AND a.started_at > NOW() - ${input.days}::int * INTERVAL '1 day'
              AND a.activity_type IN ('walking', 'hiking')
            GROUP BY date_trunc('week', a.started_at)
            ORDER BY week`,
      );

      return rows.map((r) => ({
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
      const walkRowSchema = z.object({
        date: z.string(),
        walking_speed: z.coerce.number().nullable(),
        step_length: z.coerce.number().nullable(),
        double_support_pct: z.coerce.number().nullable(),
        asymmetry_pct: z.coerce.number().nullable(),
        steadiness: z.coerce.number().nullable(),
      });
      const rows = await executeWithSchema(
        ctx.db,
        walkRowSchema,
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

      return rows.map((r) => ({
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
   * Reads from pre-computed activity_summary rollup view.
   */
  activityComparison: cachedProtectedQuery(CacheTTL.LONG)
    .input(z.object({ days: z.number().default(365) }))
    .query(async ({ ctx, input }) => {
      const compRowSchema = z.object({
        activity_name: z.string(),
        date: z.string(),
        duration_minutes: z.coerce.number(),
        average_pace_min_per_km: z.coerce.number(),
        avg_heart_rate: z.coerce.number().nullable(),
        elevation_gain_m: z.coerce.number(),
      });
      const rows = await executeWithSchema(
        ctx.db,
        compRowSchema,
        sql`WITH activity_data AS (
              SELECT
                a.name AS activity_name,
                a.started_at::date AS date,
                ROUND((EXTRACT(EPOCH FROM (a.ended_at - a.started_at)) / 60.0)::numeric, 1) AS duration_minutes,
                CASE WHEN asum.total_distance > 0
                  THEN ROUND(((EXTRACT(EPOCH FROM (a.ended_at - a.started_at)) / 60.0) / (asum.total_distance / 1000.0))::numeric, 2)
                  ELSE 0
                END AS average_pace_min_per_km,
                ROUND(asum.avg_hr::numeric, 1) AS avg_heart_rate,
                ROUND(asum.elevation_gain_m::numeric, 1) AS elevation_gain_m
              FROM fitness.v_activity a
              JOIN fitness.activity_summary asum ON asum.activity_id = a.id
              WHERE a.user_id = ${ctx.userId}
                AND a.started_at > NOW() - ${input.days}::int * INTERVAL '1 day'
                AND a.activity_type IN ('walking', 'hiking', 'trail_running')
                AND a.name IS NOT NULL
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
      for (const r of rows) {
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
