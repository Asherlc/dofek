import { mapHrZones, mapPowerZones } from "@dofek/zones/zones";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { AccessWindow } from "../billing/entitlement.ts";
import { BaseRepository } from "../lib/base-repository.ts";
import { timestampWindowStart } from "../lib/date-window.ts";
import { osmTileUrl } from "../lib/osm-tile.ts";
import { dateStringSchema, timestampStringSchema } from "../lib/typed-sql.ts";
import type { ActivityRow } from "../models/activity.ts";
import { getActivityRoutePreviews } from "./activity-route-preview.ts";
import {
  fetchRestingHeartRateRows,
  localDateString,
  representativeRestingHeartRate,
} from "./resting-heart-rate-query.ts";

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
    member_activity_ids: z.array(z.string()).optional().default([]),
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
  member_activity_ids: z.array(z.string()).optional().default([]),
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

const activitySensorWindowRowSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  started_at: timestampStringSchema,
  ended_at: timestampStringSchema.nullable(),
  member_activity_ids: z.array(z.string()),
});

const heartRateZoneParamsRowSchema = z.object({
  max_hr: z.coerce.number(),
  resting_hr: z.coerce.number(),
});

const activitySummaryReadModelRowSchema = z.object({
  activity_id: z.string(),
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
  centroid_lat: z.number().nullable().default(null),
  centroid_lng: z.number().nullable().default(null),
});

const powerCurveSampleSchema = z.object({
  activity_id: z.string(),
  activity_date: z.string(),
  power: z.coerce.number(),
  interval_s: z.coerce.number(),
});

const normalizedPowerSampleSchema = z.object({
  activity_id: z.string(),
  activity_date: z.string(),
  activity_name: z.string().nullable(),
  power: z.coerce.number(),
  interval_s: z.coerce.number(),
});

const vo2MaxEstimateSchema = z.object({
  activity_id: z.string(),
  activity_date: dateStringSchema,
  method: z.string(),
  vo2max: z.coerce.number(),
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

export interface ActivitySensorWindow {
  activityId: string;
  userId: string;
  startedAt: string;
  endedAt: string | null;
  memberActivityIds: string[];
}

export interface ActivitySensorStore {
  /**
   * Run a raw ClickHouse query against the analytics database and parse rows
   * with the supplied Zod schema. Used by repositories that previously joined
   * fitness.deduped_sensor / fitness.activity_summary and now read from
   * analytics.deduped_sensor / analytics.activity_summary.
   */
  query<TSchema extends z.ZodType>(
    schema: TSchema,
    query: string,
    params?: Record<string, unknown>,
  ): Promise<z.infer<TSchema>[]>;
  getActivitySummaries(
    activityIds: string[],
  ): Promise<z.infer<typeof activitySummaryReadModelRowSchema>[]>;
  getPowerCurveSamples(
    days: number,
    userId: string,
    timezone: string,
  ): Promise<z.infer<typeof powerCurveSampleSchema>[]>;
  getNormalizedPowerSamples(
    days: number,
    userId: string,
    timezone: string,
  ): Promise<z.infer<typeof normalizedPowerSampleSchema>[]>;
  getVo2MaxEstimates(
    endDate: string,
    days: number,
    userId: string,
    timezone: string,
  ): Promise<z.infer<typeof vo2MaxEstimateSchema>[]>;
  getHeartRateCurveRows(
    days: number,
    userId: string,
    timezone: string,
  ): Promise<Array<{ duration_seconds: number; best_hr: number; activity_date: string }>>;
  getPaceCurveRows(
    days: number,
    userId: string,
    timezone: string,
  ): Promise<Array<{ duration_seconds: number; best_pace: number; activity_date: string }>>;
  getStream(window: ActivitySensorWindow, maxPoints: number): Promise<StreamPointRow[]>;
  getHeartRateZoneSeconds(
    window: ActivitySensorWindow,
    maxHr: number,
    restingHr: number,
  ): Promise<z.infer<typeof hrZoneRowSchema>[]>;
  getPowerZoneSeconds(
    window: ActivitySensorWindow,
    ftp: number,
  ): Promise<z.infer<typeof powerZoneRowSchema>[]>;
  refreshBodyMeasurements(): Promise<void>;
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
  readonly #sensorStore?: ActivitySensorStore;

  constructor(
    db: Pick<import("dofek/db").Database, "execute">,
    userId: string,
    timezone = "UTC",
    accessWindow: AccessWindow = { kind: "full", paid: true, reason: "paid_grant" },
    sensorStore?: ActivitySensorStore,
  ) {
    super(db, userId, timezone, accessWindow);
    this.#sensorStore = sensorStore;
  }

  /** Paginated activity list with summary metrics. */
  async list(
    input: ListInput,
  ): Promise<{ items: Array<Record<string, unknown>>; totalCount: number }> {
    const rows = await this.#listRawRows(input);
    const hydratedRows = await this.#withActivitySummaries(rows);
    const totalCount = hydratedRows.length > 0 ? (hydratedRows[0]?.total_count ?? 0) : 0;
    const items = hydratedRows.map(({ total_count, member_activity_ids, ...rest }) => rest);
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
            a.member_activity_ids,
            NULL::double precision AS avg_hr,
            NULL::smallint AS max_hr,
            NULL::double precision AS avg_power,
            NULL::double precision AS distance_meters,
            COUNT(*) OVER()::int AS total_count
          FROM fitness.v_activity a
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
            a.member_activity_ids,
            NULL::double precision AS avg_hr,
            NULL::smallint AS max_hr,
            NULL::double precision AS avg_power,
            NULL::smallint AS max_power,
            NULL::double precision AS avg_speed,
            NULL::double precision AS max_speed,
            NULL::double precision AS avg_cadence,
            NULL::double precision AS total_distance,
            NULL::double precision AS elevation_gain_m,
            NULL::double precision AS elevation_loss_m,
            NULL::integer AS sample_count
          FROM fitness.v_activity a
          WHERE ${activityId}::uuid = ANY(a.member_activity_ids)
            AND a.user_id = ${this.userId}
            ${this.timestampAccessPredicate(sql`a.started_at`)}`,
    );
    const hydratedRows = await this.#withActivitySummaries(rows);
    const firstRow = hydratedRows[0];
    if (!firstRow) return null;
    const { member_activity_ids: _, ...activity } = firstRow;
    return activity;
  }

  async #withActivitySummaries<TRow extends { id: string; member_activity_ids?: string[] }>(
    rows: TRow[],
  ): Promise<TRow[]> {
    const sensorStore = this.#sensorStore;
    if (!sensorStore) {
      return rows;
    }
    if (rows.length === 0) {
      return rows;
    }

    const activityIds = [
      ...new Set(rows.flatMap((row) => [row.id, ...(row.member_activity_ids ?? [])])),
    ];
    const [summaries, routePreviewByActivityId] = await Promise.all([
      sensorStore.getActivitySummaries(activityIds),
      getActivityRoutePreviews(sensorStore, this.userId, activityIds),
    ]);
    const summaryByActivityId = new Map(
      summaries.map((summary) => [
        summary.activity_id,
        activitySummaryReadModelRowSchema.parse(summary),
      ]),
    );

    return rows.map((row) => {
      const summary = [row.id, ...(row.member_activity_ids ?? [])]
        .map((activityId) => summaryByActivityId.get(activityId))
        .find((candidate) => candidate != null);
      if (!summary) {
        return row;
      }
      const routePreview = routePreviewByActivityId.get(summary.activity_id);
      return {
        ...row,
        avg_hr: summary.avg_hr,
        max_hr: summary.max_hr,
        avg_power: summary.avg_power,
        max_power: summary.max_power,
        avg_speed: summary.avg_speed,
        max_speed: summary.max_speed,
        avg_cadence: summary.avg_cadence,
        total_distance: summary.total_distance,
        distance_meters: summary.total_distance,
        elevation_gain_m: summary.elevation_gain_m,
        elevation_loss_m: summary.elevation_loss_m,
        sample_count: summary.sample_count,
        location:
          summary.centroid_lat != null && summary.centroid_lng != null
            ? {
                centroidLat: summary.centroid_lat,
                centroidLng: summary.centroid_lng,
                tileUrl:
                  routePreview?.tileUrl ?? osmTileUrl(summary.centroid_lat, summary.centroid_lng),
                routePath: routePreview?.routePath ?? null,
                distanceMeters: summary.total_distance,
                elevationGainM: summary.elevation_gain_m,
              }
            : null,
      };
    });
  }

  /** Downsampled metric stream for a single activity. */
  async getStream(activityId: string, maxPoints: number): Promise<StreamPoint[]> {
    const sensorStore = this.#requireSensorStore("activity streams");
    const window = await this.#findActivitySensorWindow(activityId);
    if (!window) return [];
    const rows = await sensorStore.getStream(window, maxPoints);
    return rows.map((row) => new StreamPoint(streamPointRowSchema.parse(row)));
  }

  /** HR zone distribution for a single activity using the canonical Karvonen model. */
  async getHrZones(activityId: string): Promise<import("@dofek/zones/zones").ActivityHrZone[]> {
    const sensorStore = this.#requireSensorStore("heart-rate zones");
    const window = await this.#findActivitySensorWindow(activityId);
    if (!window) return mapHrZones([]);
    const params = await this.#findHeartRateZoneParams(window);
    if (!params) return mapHrZones([]);
    return mapHrZones(
      await sensorStore.getHeartRateZoneSeconds(window, params.max_hr, params.resting_hr),
    );
  }

  /** Cycling power zone distribution for a single activity using 7 zones relative to FTP. */
  async getPowerZones(
    activityId: string,
    ftp: number,
  ): Promise<import("@dofek/zones/zones").ActivityPowerZone[]> {
    const sensorStore = this.#requireSensorStore("power zones");
    const window = await this.#findActivitySensorWindow(activityId);
    if (!window) return mapPowerZones([]);
    return mapPowerZones(await sensorStore.getPowerZoneSeconds(window, ftp));
  }

  #requireSensorStore(featureName: string): ActivitySensorStore {
    if (!this.#sensorStore) {
      throw new Error(`ClickHouse activity analytics store is required for ${featureName}`);
    }
    return this.#sensorStore;
  }

  async #findActivitySensorWindow(activityId: string): Promise<ActivitySensorWindow | null> {
    const rows = await this.query(
      activitySensorWindowRowSchema,
      sql`SELECT
            a.id,
            a.user_id,
            a.started_at::text AS started_at,
            a.ended_at::text AS ended_at,
            a.member_activity_ids
          FROM fitness.v_activity a
          WHERE ${activityId}::uuid = ANY(a.member_activity_ids)
            AND a.user_id = ${this.userId}
            ${this.timestampAccessPredicate(sql`a.started_at`)}`,
    );
    const row = rows[0];
    if (!row) return null;
    return {
      activityId: row.id,
      userId: row.user_id,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      memberActivityIds: row.member_activity_ids,
    };
  }

  async #findHeartRateZoneParams(
    window: ActivitySensorWindow,
  ): Promise<z.infer<typeof heartRateZoneParamsRowSchema> | null> {
    const activityDate = localDateString(new Date(window.startedAt), this.timezone);
    const restingHeartRateRows = await fetchRestingHeartRateRows({
      sensorStore: this.#requireSensorStore("heart-rate zones"),
      userId: this.userId,
      timezone: this.timezone,
      endDate: activityDate,
      days: 3650,
    });
    const derivedRestingHeartRate = representativeRestingHeartRate(restingHeartRateRows);
    const rows = await this.query(
      heartRateZoneParamsRowSchema,
      sql`SELECT
            up.max_hr,
          CASE
            WHEN ${derivedRestingHeartRate}::real > 0
              AND ${derivedRestingHeartRate}::real < up.max_hr
            THEN ${derivedRestingHeartRate}::real
            WHEN up.resting_hr > 0
              AND up.resting_hr < up.max_hr
            THEN up.resting_hr
            ELSE LEAST(60, up.max_hr - 1)
          END AS resting_hr
          FROM fitness.user_profile up
          WHERE up.id = ${this.userId}
            AND up.max_hr > 1`,
    );
    return rows[0] ?? null;
  }

  /** Delete an activity by ID. */
  async delete(activityId: string): Promise<void> {
    await this.bulkDelete([activityId]);
  }

  /** Delete activities by visible activity IDs, including all members of matching deduped groups. */
  async bulkDelete(
    activityIds: string[],
  ): Promise<{ deletedCount: number; memberActivityIds: string[] }> {
    const uniqueActivityIds = [...new Set(activityIds)];
    if (uniqueActivityIds.length === 0) {
      return { deletedCount: 0, memberActivityIds: [] };
    }

    const memberRows = await this.query(
      z.object({ member_activity_id: z.string() }),
      sql`SELECT DISTINCT member_rows.member_activity_id::text AS member_activity_id
          FROM fitness.v_activity a
          JOIN fitness.v_activity_members selected_member ON selected_member.activity_id = a.id
          JOIN fitness.v_activity_members member_rows ON member_rows.activity_id = a.id
          WHERE selected_member.member_activity_id IN (${sql.join(
            uniqueActivityIds.map((selectedActivityId) => sql`${selectedActivityId}::uuid`),
            sql`, `,
          )})
            AND a.user_id = ${this.userId}`,
    );
    const memberActivityIds = memberRows.map((row) => row.member_activity_id);

    await this.db.execute(sql`
      DELETE FROM fitness.activity
      WHERE id IN (
        SELECT member_rows.member_activity_id
        FROM fitness.v_activity a
        JOIN fitness.v_activity_members selected_member ON selected_member.activity_id = a.id
        JOIN fitness.v_activity_members member_rows ON member_rows.activity_id = a.id
        WHERE selected_member.member_activity_id IN (${sql.join(
          uniqueActivityIds.map((selectedActivityId) => sql`${selectedActivityId}::uuid`),
          sql`, `,
        )})
          AND a.user_id = ${this.userId}
      )
      AND user_id = ${this.userId}
    `);
    return { deletedCount: uniqueActivityIds.length, memberActivityIds };
  }
}
