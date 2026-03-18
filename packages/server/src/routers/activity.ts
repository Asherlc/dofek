import { TRPCError } from "@trpc/server";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

export interface ActivityDetail {
  id: string;
  activityType: string;
  startedAt: string;
  endedAt: string | null;
  name: string | null;
  notes: string | null;
  providerId: string;
  sourceProviders: string[];
  avgHr: number | null;
  maxHr: number | null;
  avgPower: number | null;
  maxPower: number | null;
  avgSpeed: number | null;
  maxSpeed: number | null;
  avgCadence: number | null;
  totalDistance: number | null;
  elevationGain: number | null;
  elevationLoss: number | null;
  sampleCount: number | null;
}

export interface StreamPoint {
  recordedAt: string;
  heartRate: number | null;
  power: number | null;
  speed: number | null;
  cadence: number | null;
  altitude: number | null;
  lat: number | null;
  lng: number | null;
}

export interface ActivityHrZone {
  zone: number;
  label: string;
  minPct: number;
  maxPct: number;
  seconds: number;
}

export type ActivityHrZones = ActivityHrZone[];

export const activityRouter = router({
  list: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(
      z.object({
        days: z.number().default(30),
      }),
    )
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.execute(
        sql`SELECT * FROM fitness.v_activity
            WHERE user_id = ${ctx.userId}
              AND started_at > NOW() - ${input.days}::int * INTERVAL '1 day'
            ORDER BY started_at DESC`,
      );
      return rows;
    }),

  /**
   * Get a single activity with its summary data.
   * Joins v_activity with activity_summary for aggregated metrics.
   */
  byId: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }): Promise<ActivityDetail> => {
      const rows = await ctx.db.execute<{
        id: string;
        activity_type: string;
        started_at: string;
        ended_at: string | null;
        name: string | null;
        notes: string | null;
        provider_id: string;
        source_providers: string[];
        avg_hr: number | null;
        max_hr: number | null;
        avg_power: number | null;
        max_power: number | null;
        avg_speed: number | null;
        max_speed: number | null;
        avg_cadence: number | null;
        total_distance: number | null;
        elevation_gain_m: number | null;
        elevation_loss_m: number | null;
        sample_count: number | null;
      }>(
        sql`SELECT
              a.id,
              a.activity_type,
              a.started_at::text AS started_at,
              a.ended_at::text AS ended_at,
              a.name,
              a.notes,
              a.provider_id,
              a.source_providers,
              s.avg_hr,
              s.max_hr,
              s.avg_power,
              s.max_power,
              s.avg_speed,
              s.max_speed,
              s.avg_cadence,
              s.total_distance,
              s.elevation_gain_m,
              s.elevation_loss_m,
              s.sample_count
            FROM fitness.v_activity a
            LEFT JOIN fitness.activity_summary s ON s.activity_id = a.id
            WHERE a.id = ${input.id}
              AND a.user_id = ${ctx.userId}`,
      );

      const row = rows[0];
      if (!row) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Activity not found" });
      }

      return mapActivityDetail(row);
    }),

  /**
   * Get downsampled metric stream data for a single activity.
   * Uses row numbering to evenly sample points, defaulting to 500 max points.
   */
  stream: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(
      z.object({
        id: z.string().uuid(),
        maxPoints: z.number().int().min(10).max(10000).default(500),
      }),
    )
    .query(async ({ ctx, input }): Promise<StreamPoint[]> => {
      const rows = await ctx.db.execute<{
        recorded_at: string;
        heart_rate: number | null;
        power: number | null;
        speed: number | null;
        cadence: number | null;
        altitude: number | null;
        lat: number | null;
        lng: number | null;
      }>(
        sql`WITH numbered AS (
              SELECT ms.*, ROW_NUMBER() OVER (ORDER BY ms.recorded_at) AS rn,
                     COUNT(*) OVER () AS total
              FROM fitness.metric_stream ms
              JOIN fitness.v_activity a ON a.id = ms.activity_id AND a.user_id = ${ctx.userId}
              WHERE ms.activity_id = ${input.id}
            )
            SELECT recorded_at::text AS recorded_at,
                   heart_rate, power, speed, cadence, altitude, lat, lng
            FROM numbered
            WHERE rn % GREATEST(1, total / ${input.maxPoints}) = 0
            ORDER BY recorded_at`,
      );

      return rows.map(mapStreamPoint);
    }),

  /**
   * Get HR zone distribution for a single activity.
   * Computes Karvonen (Heart Rate Reserve) zones at query time using
   * the user's max_hr from their profile and resting_hr from the
   * closest daily metrics record.
   *
   * 5-zone model:
   *   Z1 (Recovery):   50-60% HRR
   *   Z2 (Aerobic):    60-70% HRR
   *   Z3 (Tempo):      70-80% HRR
   *   Z4 (Threshold):  80-90% HRR
   *   Z5 (Anaerobic):  90-100% HRR
   */
  hrZones: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }): Promise<ActivityHrZones> => {
      const rows = await ctx.db.execute<{
        zone: number;
        seconds: number;
      }>(
        sql`WITH params AS (
              SELECT
                up.max_hr,
                COALESCE(rhr.resting_hr, 60) AS resting_hr
              FROM fitness.user_profile up
              LEFT JOIN LATERAL (
                SELECT dm.resting_hr
                FROM fitness.v_daily_metrics dm
                WHERE dm.user_id = up.id
                  AND dm.date <= (
                    SELECT a.started_at::date FROM fitness.v_activity a
                    WHERE a.id = ${input.id} AND a.user_id = ${ctx.userId}
                  )
                  AND dm.resting_hr IS NOT NULL
                ORDER BY dm.date DESC
                LIMIT 1
              ) rhr ON true
              WHERE up.id = ${ctx.userId}
                AND up.max_hr IS NOT NULL
            ),
            hr_samples AS (
              SELECT ms.heart_rate
              FROM fitness.metric_stream ms
              JOIN fitness.v_activity a ON a.id = ms.activity_id AND a.user_id = ${ctx.userId}
              WHERE ms.activity_id = ${input.id}
                AND ms.heart_rate IS NOT NULL
            )
            SELECT
              z.zone,
              COUNT(hs.heart_rate)::int AS seconds
            FROM params p
            CROSS JOIN (VALUES (1), (2), (3), (4), (5)) AS z(zone)
            LEFT JOIN hr_samples hs ON
              CASE z.zone
                WHEN 1 THEN hs.heart_rate >= p.resting_hr + (p.max_hr - p.resting_hr) * 0.5
                           AND hs.heart_rate < p.resting_hr + (p.max_hr - p.resting_hr) * 0.6
                WHEN 2 THEN hs.heart_rate >= p.resting_hr + (p.max_hr - p.resting_hr) * 0.6
                           AND hs.heart_rate < p.resting_hr + (p.max_hr - p.resting_hr) * 0.7
                WHEN 3 THEN hs.heart_rate >= p.resting_hr + (p.max_hr - p.resting_hr) * 0.7
                           AND hs.heart_rate < p.resting_hr + (p.max_hr - p.resting_hr) * 0.8
                WHEN 4 THEN hs.heart_rate >= p.resting_hr + (p.max_hr - p.resting_hr) * 0.8
                           AND hs.heart_rate < p.resting_hr + (p.max_hr - p.resting_hr) * 0.9
                WHEN 5 THEN hs.heart_rate >= p.resting_hr + (p.max_hr - p.resting_hr) * 0.9
              END
            GROUP BY z.zone
            ORDER BY z.zone`,
      );

      return mapHrZones(rows);
    }),
});

/** Map a raw DB row to an ActivityDetail. Exported for unit testing. */
export function mapActivityDetail(row: {
  id: string;
  activity_type: string;
  started_at: string;
  ended_at: string | null;
  name: string | null;
  notes: string | null;
  provider_id: string;
  source_providers: string[];
  avg_hr: number | null;
  max_hr: number | null;
  avg_power: number | null;
  max_power: number | null;
  avg_speed: number | null;
  max_speed: number | null;
  avg_cadence: number | null;
  total_distance: number | null;
  elevation_gain_m: number | null;
  elevation_loss_m: number | null;
  sample_count: number | null;
}): ActivityDetail {
  return {
    id: String(row.id),
    activityType: String(row.activity_type),
    startedAt: String(row.started_at),
    endedAt: row.ended_at ? String(row.ended_at) : null,
    name: row.name ? String(row.name) : null,
    notes: row.notes ? String(row.notes) : null,
    providerId: String(row.provider_id),
    sourceProviders: row.source_providers ?? [],
    avgHr: row.avg_hr != null ? Number(row.avg_hr) : null,
    maxHr: row.max_hr != null ? Number(row.max_hr) : null,
    avgPower: row.avg_power != null ? Number(row.avg_power) : null,
    maxPower: row.max_power != null ? Number(row.max_power) : null,
    avgSpeed: row.avg_speed != null ? Number(row.avg_speed) : null,
    maxSpeed: row.max_speed != null ? Number(row.max_speed) : null,
    avgCadence: row.avg_cadence != null ? Number(row.avg_cadence) : null,
    totalDistance: row.total_distance != null ? Number(row.total_distance) : null,
    elevationGain: row.elevation_gain_m != null ? Number(row.elevation_gain_m) : null,
    elevationLoss: row.elevation_loss_m != null ? Number(row.elevation_loss_m) : null,
    sampleCount: row.sample_count != null ? Number(row.sample_count) : null,
  };
}

/** Map a raw stream row to a StreamPoint. Exported for unit testing. */
export function mapStreamPoint(row: {
  recorded_at: string;
  heart_rate: number | null;
  power: number | null;
  speed: number | null;
  cadence: number | null;
  altitude: number | null;
  lat: number | null;
  lng: number | null;
}): StreamPoint {
  return {
    recordedAt: String(row.recorded_at),
    heartRate: row.heart_rate != null ? Number(row.heart_rate) : null,
    power: row.power != null ? Number(row.power) : null,
    speed: row.speed != null ? Number(row.speed) : null,
    cadence: row.cadence != null ? Number(row.cadence) : null,
    altitude: row.altitude != null ? Number(row.altitude) : null,
    lat: row.lat != null ? Number(row.lat) : null,
    lng: row.lng != null ? Number(row.lng) : null,
  };
}

/** Map raw HR zone rows to the full 5-zone structure. Exported for unit testing. */
export function mapHrZones(rows: { zone: number; seconds: number }[]): ActivityHrZones {
  const zoneLabels = [
    { zone: 1, label: "Recovery", minPct: 50, maxPct: 60 },
    { zone: 2, label: "Aerobic", minPct: 60, maxPct: 70 },
    { zone: 3, label: "Tempo", minPct: 70, maxPct: 80 },
    { zone: 4, label: "Threshold", minPct: 80, maxPct: 90 },
    { zone: 5, label: "Anaerobic", minPct: 90, maxPct: 100 },
  ];

  return zoneLabels.map((zl) => {
    const row = rows.find((r) => Number(r.zone) === zl.zone);
    return {
      zone: zl.zone,
      label: zl.label,
      minPct: zl.minPct,
      maxPct: zl.maxPct,
      seconds: row ? Number(row.seconds) : 0,
    };
  });
}
