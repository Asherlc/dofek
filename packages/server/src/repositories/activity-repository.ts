import { mapHrZones } from "@dofek/zones/zones";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { BaseRepository } from "../lib/base-repository.ts";
import { timestampWindowStart } from "../lib/date-window.ts";
import { restingHeartRateLateral } from "../lib/sql-fragments.ts";
import { timestampStringSchema } from "../lib/typed-sql.ts";
import type { ActivityRow } from "../models/activity.ts";

// ---------------------------------------------------------------------------
// Zod schemas for raw DB rows
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Domain models
// ---------------------------------------------------------------------------

export interface StreamPointRow {
  recorded_at: string;
  heart_rate: number | null;
  power: number | null;
  speed: number | null;
  cadence: number | null;
  altitude: number | null;
  lat: number | null;
  lng: number | null;
}

/** A single data point from an activity's metric stream. */
export class StreamPoint {
  readonly #row: StreamPointRow;

  constructor(row: StreamPointRow) {
    this.#row = row;
  }

  toDetail() {
    return {
      recordedAt: String(this.#row.recorded_at),
      heartRate: this.#row.heart_rate != null ? Number(this.#row.heart_rate) : null,
      power: this.#row.power != null ? Number(this.#row.power) : null,
      speed: this.#row.speed != null ? Number(this.#row.speed) : null,
      cadence: this.#row.cadence != null ? Number(this.#row.cadence) : null,
      altitude: this.#row.altitude != null ? Number(this.#row.altitude) : null,
      lat: this.#row.lat != null ? Number(this.#row.lat) : null,
      lng: this.#row.lng != null ? Number(this.#row.lng) : null,
    };
  }
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

/** Input parameters for the activity list query. */
export interface ListInput {
  days: number;
  endDate: string;
  limit: number;
  offset: number;
  activityTypes?: string[];
}

/** Data access for activity queries. */
export class ActivityRepository extends BaseRepository {
  /** Paginated activity list with summary metrics. Self-heals stale views on the first page. */
  async list(
    input: ListInput,
  ): Promise<{ items: Array<Record<string, unknown>>; totalCount: number }> {
    const queryFn = () => this.#listRawRows(input);

    // Only check staleness on the first page to avoid expensive refreshes on
    // legitimate empty later pages.
    const rows =
      input.offset === 0
        ? await this.queryWithViewRefresh(queryFn, input.days, "activityList")
        : await queryFn();

    const totalCount = rows.length > 0 ? (rows[0]?.total_count ?? 0) : 0;
    const items = rows.map(({ total_count, ...rest }) => rest);
    return { items, totalCount };
  }

  #listRawRows(input: ListInput) {
    const typeFilter =
      input.activityTypes && input.activityTypes.length > 0
        ? sql`AND a.activity_type = ANY(ARRAY[${sql.join(
            input.activityTypes.map((type) => sql`${type}`),
            sql`, `,
          )}])`
        : sql``;
    return this.query(
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
            COUNT(*) OVER()::int AS total_count
          FROM fitness.v_activity a
          LEFT JOIN fitness.activity_summary s ON s.activity_id = a.id
          WHERE a.user_id = ${this.userId}
            AND a.started_at > ${timestampWindowStart(input.endDate, input.days)}
            ${typeFilter}
          ORDER BY a.started_at DESC
          LIMIT ${input.limit} OFFSET ${input.offset}`,
    );
  }

  /** Single activity with full detail row. Returns null when not found. */
  async findById(activityId: string): Promise<ActivityRow | null> {
    const rows = await this.query(
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
            s.sample_count
          FROM fitness.v_activity a
          LEFT JOIN fitness.activity_summary s ON s.activity_id = a.id
          WHERE a.id = ${activityId}
            AND a.user_id = ${this.userId}`,
    );
    return rows[0] ?? null;
  }

  /** Downsampled metric stream for a single activity. */
  async getStream(activityId: string, maxPoints: number): Promise<StreamPoint[]> {
    const rows = await this.query(
      streamPointRowSchema,
      sql`WITH pivoted AS (
            SELECT
              ds.recorded_at,
              MAX(ds.scalar) FILTER (WHERE ds.channel = 'heart_rate')::SMALLINT AS heart_rate,
              MAX(ds.scalar) FILTER (WHERE ds.channel = 'power')::SMALLINT AS power,
              MAX(ds.scalar) FILTER (WHERE ds.channel = 'speed') AS speed,
              MAX(ds.scalar) FILTER (WHERE ds.channel = 'cadence')::SMALLINT AS cadence,
              MAX(ds.scalar) FILTER (WHERE ds.channel = 'altitude') AS altitude,
              MAX(ds.scalar) FILTER (WHERE ds.channel = 'lat') AS lat,
              MAX(ds.scalar) FILTER (WHERE ds.channel = 'lng') AS lng
            FROM fitness.deduped_sensor ds
            WHERE ds.activity_id = ${activityId}
              AND ds.user_id = ${this.userId}
              AND ds.channel IN ('heart_rate', 'power', 'speed', 'cadence', 'altitude', 'lat', 'lng')
            GROUP BY ds.recorded_at
          ),
          numbered AS (
            SELECT p.*, ROW_NUMBER() OVER (ORDER BY p.recorded_at) AS rn,
                   COUNT(*) OVER () AS total
            FROM pivoted p
          )
          SELECT recorded_at::text AS recorded_at,
                 heart_rate, power, speed, cadence, altitude, lat, lng
          FROM numbered
          WHERE rn % GREATEST(1, total / ${maxPoints}) = 0
          ORDER BY recorded_at`,
    );

    return rows.map((row) => new StreamPoint(row));
  }

  /** HR zone distribution for a single activity using Karvonen zones. */
  async getHrZones(activityId: string): Promise<import("@dofek/zones/zones").ActivityHrZone[]> {
    const rows = await this.query(
      hrZoneRowSchema,
      sql`WITH params AS (
            SELECT
              up.max_hr,
              COALESCE(rhr.resting_hr, 60) AS resting_hr
            FROM fitness.user_profile up
            LEFT JOIN ${restingHeartRateLateral(
              sql`up.id`,
              sql`(SELECT (a.started_at AT TIME ZONE ${this.timezone})::date FROM fitness.v_activity a WHERE a.id = ${activityId} AND a.user_id = ${this.userId})`,
            )}
            WHERE up.id = ${this.userId}
              AND up.max_hr IS NOT NULL
          ),
          hr_samples AS (
            SELECT ds.scalar AS heart_rate
            FROM fitness.deduped_sensor ds
            WHERE ds.activity_id = ${activityId}
              AND ds.user_id = ${this.userId}
              AND ds.channel = 'heart_rate'
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
  }

  /** Delete an activity by ID. */
  async delete(activityId: string): Promise<void> {
    await this.db.execute(sql`
      DELETE FROM fitness.activity
      WHERE id = ${activityId}::uuid AND user_id = ${this.userId}
    `);
  }
}
