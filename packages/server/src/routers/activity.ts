import { providerLabel } from "@dofek/providers/providers";
import { activitySourceUrl } from "@dofek/providers/source-links";
import { mapHrZones } from "@dofek/zones/zones";
import { TRPCError } from "@trpc/server";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { endDateSchema, timestampWindowStart } from "../lib/date-window.ts";
import { executeWithSchema, timestampStringSchema } from "../lib/typed-sql.ts";
import { CacheTTL, cachedProtectedQuery, protectedProcedure, router } from "../trpc.ts";

const activityListRowSchema = z
  .object({
    id: z.string(),
    activity_type: z.string(),
    started_at: timestampStringSchema,
    ended_at: timestampStringSchema.nullable(),
    name: z.string().nullable(),
    provider_id: z.string(),
    source_providers: z.array(z.string()),
    avg_hr: z.number().nullable(),
    max_hr: z.number().nullable(),
    avg_power: z.number().nullable(),
    distance_meters: z.number().nullable(),
    calories: z.number().nullable(),
    total_count: z.coerce.number(),
  })
  .passthrough();

const sourceExternalIdSchema = z.object({
  providerId: z.string(),
  externalId: z.string(),
});

const activityDetailRowSchema = z.object({
  id: z.string(),
  activity_type: z.string(),
  started_at: timestampStringSchema,
  ended_at: timestampStringSchema.nullable(),
  name: z.string().nullable(),
  notes: z.string().nullable(),
  provider_id: z.string(),
  source_providers: z.array(z.string()),
  source_external_ids: z.array(sourceExternalIdSchema).nullable(),
  avg_hr: z.number().nullable(),
  max_hr: z.number().nullable(),
  avg_power: z.number().nullable(),
  max_power: z.number().nullable(),
  avg_speed: z.number().nullable(),
  max_speed: z.number().nullable(),
  avg_cadence: z.number().nullable(),
  total_distance: z.number().nullable(),
  elevation_gain_m: z.number().nullable(),
  elevation_loss_m: z.number().nullable(),
  calories: z.number().nullable(),
  sample_count: z.number().nullable(),
});

const streamPointRowSchema = z.object({
  recorded_at: timestampStringSchema,
  heart_rate: z.number().nullable(),
  power: z.number().nullable(),
  speed: z.number().nullable(),
  cadence: z.number().nullable(),
  altitude: z.number().nullable(),
  lat: z.number().nullable(),
  lng: z.number().nullable(),
});

const hrZoneRowSchema = z.object({
  zone: z.coerce.number(),
  seconds: z.coerce.number(),
});

export interface SourceLink {
  providerId: string;
  label: string;
  url: string;
}

export interface ActivityDetail {
  id: string;
  activityType: string;
  startedAt: string;
  endedAt: string | null;
  name: string | null;
  notes: string | null;
  providerId: string;
  sourceProviders: string[];
  sourceLinks: SourceLink[];
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
  calories: number | null;
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

export type { ActivityHrZone } from "@dofek/zones/zones";
export type ActivityHrZones = import("@dofek/zones/zones").ActivityHrZone[];

export const activityRouter = router({
  list: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(
      z.object({
        days: z.number().default(30),
        endDate: endDateSchema,
        limit: z.number().min(1).max(100).default(20),
        offset: z.number().min(0).default(0),
      }),
    )
    .query(async ({ ctx, input }) => {
      const rows = await executeWithSchema(
        ctx.db,
        activityListRowSchema,
        sql`SELECT
              a.id,
              a.activity_type,
              a.started_at::text AS started_at,
              a.ended_at::text AS ended_at,
              a.name,
              a.provider_id,
              a.source_providers,
              s.avg_hr,
              s.max_hr,
              s.avg_power,
              s.total_distance AS distance_meters,
              COALESCE(
                (a.raw->>'calories')::REAL,
                (a.raw->>'totalEnergyBurned')::REAL,
                (a.raw->>'total_energy_burned')::REAL
              ) AS calories,
              COUNT(*) OVER()::int AS total_count
            FROM fitness.v_activity a
            LEFT JOIN fitness.activity_summary s ON s.activity_id = a.id
            WHERE a.user_id = ${ctx.userId}
              AND a.started_at > ${timestampWindowStart(input.endDate, input.days)}
            ORDER BY a.started_at DESC
            LIMIT ${input.limit} OFFSET ${input.offset}`,
      );
      const totalCount = rows.length > 0 ? (rows[0]?.total_count ?? 0) : 0;
      const items = rows.map(({ total_count, ...rest }) => rest);
      return { items, totalCount };
    }),

  /**
   * Get a single activity with its summary data.
   * Joins v_activity with activity_summary for aggregated metrics.
   */
  byId: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }): Promise<ActivityDetail> => {
      const rows = await executeWithSchema(
        ctx.db,
        activityDetailRowSchema,
        sql`SELECT
              a.id,
              a.activity_type,
              a.started_at::text AS started_at,
              a.ended_at::text AS ended_at,
              a.name,
              a.notes,
              a.provider_id,
              a.source_providers,
              a.source_external_ids,
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
              COALESCE(
                (a.raw->>'calories')::REAL,
                (a.raw->>'totalEnergyBurned')::REAL,
                (a.raw->>'total_energy_burned')::REAL
              ) AS calories,
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
      const rows = await executeWithSchema(
        ctx.db,
        streamPointRowSchema,
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
      const rows = await executeWithSchema(
        ctx.db,
        hrZoneRowSchema,
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
                    SELECT (a.started_at AT TIME ZONE ${ctx.timezone})::date FROM fitness.v_activity a
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

  delete: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db.execute(sql`
        DELETE FROM fitness.activity
        WHERE id = ${input.id}::uuid AND user_id = ${ctx.userId}
      `);
      return { success: true };
    }),
});

/** Build source links from provider external IDs. Exported for unit testing. */
export function buildSourceLinks(
  sourceExternalIds: Array<{ providerId: string; externalId: string }> | null,
): SourceLink[] {
  if (!sourceExternalIds) return [];
  const links: SourceLink[] = [];
  for (const { providerId, externalId } of sourceExternalIds) {
    const url = activitySourceUrl(providerId, externalId);
    if (url) {
      links.push({ providerId, label: providerLabel(providerId), url });
    }
  }
  return links;
}

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
  source_external_ids: Array<{ providerId: string; externalId: string }> | null;
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
  calories: number | null;
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
    sourceLinks: buildSourceLinks(row.source_external_ids),
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
    calories: row.calories != null ? Number(row.calories) : null,
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

// Re-export mapHrZones for backward compatibility with consumers
export { mapHrZones } from "@dofek/zones/zones";
