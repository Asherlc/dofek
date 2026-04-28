import { mapHrZones, mapPowerZones } from "@dofek/zones/zones";
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
  subsource: z.string().nullable(),
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

const powerZoneRowSchema = z.object({
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
        ? sql`AND a.activity_type IN (${sql.join(
            input.activityTypes.map((type) => sql`${type}`),
            sql`, `,
          )})`
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
            COALESCE(
              s.avg_hr,
              CASE WHEN jsonb_typeof(a.raw->'avgHeartRate') = 'number'
                THEN (a.raw->>'avgHeartRate')::real
              END
            ) AS avg_hr,
            COALESCE(
              s.max_hr,
              CASE WHEN jsonb_typeof(a.raw->'maxHeartRate') = 'number'
                THEN (a.raw->>'maxHeartRate')::smallint
              END
            ) AS max_hr,
            s.avg_power,
            s.total_distance AS distance_meters,
            COUNT(*) OVER()::int AS total_count
          FROM fitness.v_activity a
          LEFT JOIN fitness.activity_summary s ON s.activity_id = a.id
          WHERE a.user_id = ${this.userId}
            AND a.started_at > ${timestampWindowStart(input.endDate, input.days)}
            ${typeFilter}
            ${this.timestampAccessPredicate(sql`a.started_at`)}
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
            a.raw->>'sourceName' AS subsource,
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
            AND a.user_id = ${this.userId}
            ${this.timestampAccessPredicate(sql`a.started_at`)}`,
    );
    return rows[0] ?? null;
  }

  /** Downsampled metric stream for a single activity. */
  async getStream(activityId: string, maxPoints: number): Promise<StreamPoint[]> {
    const rows = await this.query(
      streamPointRowSchema,
      sql`WITH target_activity AS (
            SELECT id, user_id, started_at, ended_at, member_activity_ids
            FROM fitness.v_activity a
            WHERE a.id = ${activityId}
              AND a.user_id = ${this.userId}
              ${this.timestampAccessPredicate(sql`a.started_at`)}
          ),
          activity_members AS (
            SELECT
              ta.id AS canonical_id,
              ta.user_id,
              unnest(ta.member_activity_ids) AS member_id
            FROM target_activity ta
          ),
          linked_best_source AS (
            SELECT DISTINCT ON (canonical_id, channel)
              canonical_id,
              channel,
              provider_id
            FROM (
              SELECT
                am.canonical_id,
                ms.channel,
                ms.provider_id,
                COUNT(*) AS sample_count
              FROM fitness.metric_stream ms
              JOIN activity_members am ON ms.activity_id = am.member_id
              WHERE ms.activity_id IS NOT NULL
                AND ms.channel IN ('heart_rate', 'power', 'speed', 'cadence', 'altitude', 'lat', 'lng')
              GROUP BY am.canonical_id, ms.channel, ms.provider_id
            ) counts
            ORDER BY canonical_id, channel, sample_count DESC
          ),
          linked_sample_bounds AS (
            SELECT am.canonical_id, MAX(ms.recorded_at) AS last_linked_sample_at
            FROM fitness.metric_stream ms
            JOIN activity_members am ON ms.activity_id = am.member_id
            WHERE ms.activity_id IS NOT NULL
            GROUP BY am.canonical_id
          ),
          fallback_windows AS (
            SELECT
              ta.id AS canonical_id,
              ta.user_id,
              ta.started_at,
              COALESCE(ta.ended_at, lsb.last_linked_sample_at) AS fallback_ended_at
            FROM target_activity ta
            LEFT JOIN linked_sample_bounds lsb ON lsb.canonical_id = ta.id
          ),
          ambient_best_source AS (
            SELECT DISTINCT ON (canonical_id, channel)
              canonical_id,
              channel,
              provider_id
            FROM (
              SELECT
                fw.canonical_id,
                ms.channel,
                ms.provider_id,
                COUNT(*) AS sample_count
              FROM fitness.metric_stream ms
              JOIN fallback_windows fw ON fw.user_id = ms.user_id
              LEFT JOIN linked_best_source lbs
                ON lbs.canonical_id = fw.canonical_id
                AND lbs.channel = ms.channel
              WHERE ms.activity_id IS NULL
                AND fw.fallback_ended_at IS NOT NULL
                AND ms.recorded_at >= fw.started_at
                AND ms.recorded_at <= fw.fallback_ended_at
                AND ms.channel IN ('heart_rate', 'power', 'speed', 'cadence', 'altitude', 'lat', 'lng')
                AND lbs.canonical_id IS NULL
              GROUP BY fw.canonical_id, ms.channel, ms.provider_id
            ) counts
            ORDER BY canonical_id, channel, sample_count DESC
          ),
          scoped_sensor AS (
            SELECT
              am.canonical_id AS activity_id,
              am.user_id,
              ms.recorded_at,
              ms.channel,
              MAX(ms.scalar) AS scalar
            FROM fitness.metric_stream ms
            JOIN activity_members am ON ms.activity_id = am.member_id
            JOIN linked_best_source lbs
              ON am.canonical_id = lbs.canonical_id
              AND ms.channel = lbs.channel
              AND ms.provider_id = lbs.provider_id
            WHERE ms.activity_id IS NOT NULL
              AND ms.scalar IS NOT NULL
            GROUP BY am.canonical_id, am.user_id, ms.recorded_at, ms.channel
            UNION ALL
            SELECT
              fw.canonical_id AS activity_id,
              fw.user_id,
              ms.recorded_at,
              ms.channel,
              MAX(ms.scalar) AS scalar
            FROM fitness.metric_stream ms
            JOIN fallback_windows fw ON fw.user_id = ms.user_id
            JOIN ambient_best_source abs
              ON fw.canonical_id = abs.canonical_id
              AND ms.channel = abs.channel
              AND ms.provider_id = abs.provider_id
            WHERE ms.activity_id IS NULL
              AND fw.fallback_ended_at IS NOT NULL
              AND ms.recorded_at >= fw.started_at
              AND ms.recorded_at <= fw.fallback_ended_at
              AND ms.scalar IS NOT NULL
            GROUP BY fw.canonical_id, fw.user_id, ms.recorded_at, ms.channel
          ),
          pivoted AS (
            SELECT
              ss.recorded_at,
              MAX(ss.scalar) FILTER (WHERE ss.channel = 'heart_rate')::SMALLINT AS heart_rate,
              MAX(ss.scalar) FILTER (WHERE ss.channel = 'power')::SMALLINT AS power,
              MAX(ss.scalar) FILTER (WHERE ss.channel = 'speed') AS speed,
              MAX(ss.scalar) FILTER (WHERE ss.channel = 'cadence')::SMALLINT AS cadence,
              MAX(ss.scalar) FILTER (WHERE ss.channel = 'altitude') AS altitude,
              MAX(ss.scalar) FILTER (WHERE ss.channel = 'lat') AS lat,
              MAX(ss.scalar) FILTER (WHERE ss.channel = 'lng') AS lng
            FROM scoped_sensor ss
            GROUP BY ss.recorded_at
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
      sql`WITH target_activity AS (
            SELECT id, user_id, started_at, ended_at, member_activity_ids
            FROM fitness.v_activity a
            WHERE a.id = ${activityId}
              AND a.user_id = ${this.userId}
              ${this.timestampAccessPredicate(sql`a.started_at`)}
          ),
          activity_members AS (
            SELECT
              ta.id AS canonical_id,
              ta.user_id,
              unnest(ta.member_activity_ids) AS member_id
            FROM target_activity ta
          ),
          linked_best_source AS (
            SELECT DISTINCT ON (canonical_id, channel)
              canonical_id,
              channel,
              provider_id
            FROM (
              SELECT
                am.canonical_id,
                ms.channel,
                ms.provider_id,
                COUNT(*) AS sample_count
              FROM fitness.metric_stream ms
              JOIN activity_members am ON ms.activity_id = am.member_id
              WHERE ms.activity_id IS NOT NULL
                AND ms.channel = 'heart_rate'
              GROUP BY am.canonical_id, ms.channel, ms.provider_id
            ) counts
            ORDER BY canonical_id, channel, sample_count DESC
          ),
          linked_sample_bounds AS (
            SELECT am.canonical_id, MAX(ms.recorded_at) AS last_linked_sample_at
            FROM fitness.metric_stream ms
            JOIN activity_members am ON ms.activity_id = am.member_id
            WHERE ms.activity_id IS NOT NULL
            GROUP BY am.canonical_id
          ),
          fallback_windows AS (
            SELECT
              ta.id AS canonical_id,
              ta.user_id,
              ta.started_at,
              COALESCE(ta.ended_at, lsb.last_linked_sample_at) AS fallback_ended_at
            FROM target_activity ta
            LEFT JOIN linked_sample_bounds lsb ON lsb.canonical_id = ta.id
          ),
          ambient_best_source AS (
            SELECT DISTINCT ON (canonical_id, channel)
              canonical_id,
              channel,
              provider_id
            FROM (
              SELECT
                fw.canonical_id,
                ms.channel,
                ms.provider_id,
                COUNT(*) AS sample_count
              FROM fitness.metric_stream ms
              JOIN fallback_windows fw ON fw.user_id = ms.user_id
              LEFT JOIN linked_best_source lbs
                ON lbs.canonical_id = fw.canonical_id
                AND lbs.channel = ms.channel
              WHERE ms.activity_id IS NULL
                AND fw.fallback_ended_at IS NOT NULL
                AND ms.recorded_at >= fw.started_at
                AND ms.recorded_at <= fw.fallback_ended_at
                AND ms.channel = 'heart_rate'
                AND lbs.canonical_id IS NULL
              GROUP BY fw.canonical_id, ms.channel, ms.provider_id
            ) counts
            ORDER BY canonical_id, channel, sample_count DESC
          ),
          hr_samples AS (
            SELECT ms.scalar AS heart_rate
            FROM fitness.metric_stream ms
            JOIN activity_members am ON ms.activity_id = am.member_id
            JOIN linked_best_source lbs
              ON am.canonical_id = lbs.canonical_id
              AND ms.channel = lbs.channel
              AND ms.provider_id = lbs.provider_id
            WHERE ms.activity_id IS NOT NULL
              AND ms.channel = 'heart_rate'
              AND ms.scalar IS NOT NULL
            UNION ALL
            SELECT ms.scalar AS heart_rate
            FROM fitness.metric_stream ms
            JOIN fallback_windows fw ON fw.user_id = ms.user_id
            JOIN ambient_best_source abs
              ON fw.canonical_id = abs.canonical_id
              AND ms.channel = abs.channel
              AND ms.provider_id = abs.provider_id
            WHERE ms.activity_id IS NULL
              AND fw.fallback_ended_at IS NOT NULL
              AND ms.recorded_at >= fw.started_at
              AND ms.recorded_at <= fw.fallback_ended_at
              AND ms.channel = 'heart_rate'
              AND ms.scalar IS NOT NULL
          ),
          params AS (
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

  /** Cycling power zone distribution for a single activity using 7 zones relative to FTP. */
  async getPowerZones(
    activityId: string,
    ftp: number,
  ): Promise<import("@dofek/zones/zones").ActivityPowerZone[]> {
    const rows = await this.query(
      powerZoneRowSchema,
      sql`WITH power_samples AS (
            SELECT ds.scalar AS power
            FROM fitness.deduped_sensor ds
            WHERE ds.activity_id = ${activityId}
              AND ds.user_id = ${this.userId}
              AND ds.channel = 'power'
              AND EXISTS (
                SELECT 1 FROM fitness.v_activity a
                WHERE a.id = ${activityId} AND a.user_id = ${this.userId}
                ${this.timestampAccessPredicate(sql`a.started_at`)}
              )
          )
          SELECT
            z.zone,
            COUNT(ps.power)::int AS seconds
          FROM (VALUES (1), (2), (3), (4), (5), (6), (7)) AS z(zone)
          LEFT JOIN power_samples ps ON
            CASE z.zone
              WHEN 1 THEN ps.power < ${ftp} * 0.55
              WHEN 2 THEN ps.power >= ${ftp} * 0.55 AND ps.power < ${ftp} * 0.75
              WHEN 3 THEN ps.power >= ${ftp} * 0.75 AND ps.power < ${ftp} * 0.9
              WHEN 4 THEN ps.power >= ${ftp} * 0.9 AND ps.power < ${ftp} * 1.05
              WHEN 5 THEN ps.power >= ${ftp} * 1.05 AND ps.power < ${ftp} * 1.2
              WHEN 6 THEN ps.power >= ${ftp} * 1.2 AND ps.power < ${ftp} * 1.5
              WHEN 7 THEN ps.power >= ${ftp} * 1.5
            END
          GROUP BY z.zone
          ORDER BY z.zone`,
    );

    return mapPowerZones(rows);
  }

  /** Delete an activity by ID. */
  async delete(activityId: string): Promise<void> {
    await this.db.execute(sql`
      DELETE FROM fitness.activity
      WHERE id = ${activityId}::uuid AND user_id = ${this.userId}
    `);
  }
}
