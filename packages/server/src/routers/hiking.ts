import { sql } from "drizzle-orm";
import { z } from "zod";
import { CacheTTL, cachedQuery, router } from "../trpc.ts";

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
   */
  gradeAdjustedPace: cachedQuery(CacheTTL.LONG)
    .input(z.object({ days: z.number().default(90) }))
    .query(async ({ ctx, input }) => {
      interface GradeRow {
        date: string;
        activity_name: string;
        activity_type: string;
        distance_m: number;
        duration_seconds: number;
        elevation_gain_m: number;
        elevation_loss_m: number;
        avg_grade: number;
      }
      const rows = await ctx.db.execute(
        sql`WITH activity_streams AS (
              SELECT
                a.id AS activity_id,
                a.started_at::date AS date,
                a.name AS activity_name,
                a.activity_type,
                EXTRACT(EPOCH FROM (a.ended_at - a.started_at)) AS duration_seconds,
                MAX(ms.distance) AS distance_m,
                ms.altitude,
                LAG(ms.altitude) OVER (PARTITION BY a.id ORDER BY ms.recorded_at) AS prev_altitude
              FROM fitness.v_activity a
              JOIN fitness.metric_stream ms ON ms.activity_id = a.id
              WHERE a.started_at > NOW() - ${input.days}::int * INTERVAL '1 day'
                AND a.activity_type IN ('walking', 'hiking', 'trail_running')
                AND ms.altitude IS NOT NULL
              GROUP BY a.id, a.started_at, a.ended_at, a.name, a.activity_type,
                       ms.altitude, ms.recorded_at
            ),
            activity_elevation AS (
              SELECT
                activity_id,
                date,
                activity_name,
                activity_type,
                duration_seconds,
                MAX(distance_m) AS distance_m,
                SUM(CASE WHEN altitude - prev_altitude > 0 THEN altitude - prev_altitude ELSE 0 END) AS elevation_gain_m,
                SUM(CASE WHEN altitude - prev_altitude < 0 THEN ABS(altitude - prev_altitude) ELSE 0 END) AS elevation_loss_m,
                CASE WHEN MAX(distance_m) > 0
                  THEN (SUM(CASE WHEN altitude - prev_altitude > 0 THEN altitude - prev_altitude ELSE 0 END)
                      - SUM(CASE WHEN altitude - prev_altitude < 0 THEN ABS(altitude - prev_altitude) ELSE 0 END))
                      / MAX(distance_m) * 100
                  ELSE 0
                END AS avg_grade
              FROM activity_streams
              WHERE prev_altitude IS NOT NULL
              GROUP BY activity_id, date, activity_name, activity_type, duration_seconds
              HAVING MAX(distance_m) > 0 AND duration_seconds > 0
            )
            SELECT
              date::text,
              activity_name,
              activity_type,
              ROUND(distance_m::numeric, 1) AS distance_m,
              ROUND(duration_seconds::numeric, 1) AS duration_seconds,
              ROUND(elevation_gain_m::numeric, 1) AS elevation_gain_m,
              ROUND(elevation_loss_m::numeric, 1) AS elevation_loss_m,
              ROUND(avg_grade::numeric, 4) AS avg_grade
            FROM activity_elevation
            ORDER BY date`,
      );

      return (rows as unknown as GradeRow[]).map((r) => {
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
   */
  elevationProfile: cachedQuery(CacheTTL.LONG)
    .input(z.object({ days: z.number().default(365) }))
    .query(async ({ ctx, input }) => {
      interface ElevRow {
        week: string;
        elevation_gain_m: number;
        activity_count: number;
        total_distance_km: number;
      }
      const rows = await ctx.db.execute(
        sql`WITH altitude_deltas AS (
              SELECT
                a.id AS activity_id,
                a.started_at,
                ms.altitude,
                LAG(ms.altitude) OVER (PARTITION BY a.id ORDER BY ms.recorded_at) AS prev_altitude,
                MAX(ms.distance) OVER (PARTITION BY a.id) AS max_distance
              FROM fitness.v_activity a
              JOIN fitness.metric_stream ms ON ms.activity_id = a.id
              WHERE a.started_at > NOW() - ${input.days}::int * INTERVAL '1 day'
                AND a.activity_type IN ('walking', 'hiking')
                AND ms.altitude IS NOT NULL
            ),
            activity_gains AS (
              SELECT
                activity_id,
                MIN(started_at) AS started_at,
                SUM(CASE WHEN altitude - prev_altitude > 0 THEN altitude - prev_altitude ELSE 0 END) AS elevation_gain_m,
                MAX(max_distance) / 1000.0 AS distance_km
              FROM altitude_deltas
              WHERE prev_altitude IS NOT NULL
              GROUP BY activity_id
            )
            SELECT
              date_trunc('week', started_at)::date::text AS week,
              ROUND(SUM(elevation_gain_m)::numeric, 1) AS elevation_gain_m,
              COUNT(*)::int AS activity_count,
              ROUND(SUM(distance_km)::numeric, 2) AS total_distance_km
            FROM activity_gains
            GROUP BY date_trunc('week', started_at)
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
  walkingBiomechanics: cachedQuery(CacheTTL.LONG)
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
            FROM fitness.v_daily_metrics
            WHERE date > NOW() - ${input.days}::int * INTERVAL '1 day'
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
   */
  activityComparison: cachedQuery(CacheTTL.LONG)
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
        sql`WITH altitude_deltas AS (
              SELECT
                a.id AS activity_id,
                a.name AS activity_name,
                a.started_at,
                a.ended_at,
                ms.altitude,
                LAG(ms.altitude) OVER (PARTITION BY a.id ORDER BY ms.recorded_at) AS prev_altitude,
                MAX(ms.distance) OVER (PARTITION BY a.id) AS max_distance,
                ms.heart_rate
              FROM fitness.v_activity a
              JOIN fitness.metric_stream ms ON ms.activity_id = a.id
              WHERE a.started_at > NOW() - ${input.days}::int * INTERVAL '1 day'
                AND a.activity_type IN ('walking', 'hiking', 'trail_running')
                AND a.name IS NOT NULL
            ),
            activity_summaries AS (
              SELECT
                activity_id,
                activity_name,
                MIN(started_at)::date AS date,
                EXTRACT(EPOCH FROM (MIN(ended_at) - MIN(started_at))) / 60.0 AS duration_minutes,
                CASE WHEN MAX(max_distance) > 0
                  THEN (EXTRACT(EPOCH FROM (MIN(ended_at) - MIN(started_at))) / 60.0)
                       / (MAX(max_distance) / 1000.0)
                  ELSE 0
                END AS average_pace_min_per_km,
                ROUND(AVG(heart_rate)::numeric, 1) AS avg_heart_rate,
                SUM(CASE WHEN altitude IS NOT NULL AND prev_altitude IS NOT NULL
                         AND altitude - prev_altitude > 0
                    THEN altitude - prev_altitude ELSE 0 END) AS elevation_gain_m
              FROM altitude_deltas
              GROUP BY activity_id, activity_name
            ),
            repeated_names AS (
              SELECT activity_name
              FROM activity_summaries
              GROUP BY activity_name
              HAVING COUNT(*) >= 2
            )
            SELECT
              s.activity_name,
              s.date::text,
              ROUND(s.duration_minutes::numeric, 1) AS duration_minutes,
              ROUND(s.average_pace_min_per_km::numeric, 2) AS average_pace_min_per_km,
              s.avg_heart_rate,
              ROUND(s.elevation_gain_m::numeric, 1) AS elevation_gain_m
            FROM activity_summaries s
            JOIN repeated_names rn ON rn.activity_name = s.activity_name
            ORDER BY s.activity_name, s.date`,
      );

      const grouped = new Map<string, ActivityComparisonInstance[]>();
      for (const r of rows as unknown as CompRow[]) {
        const name = String(r.activity_name);
        if (!grouped.has(name)) {
          grouped.set(name, []);
        }
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
