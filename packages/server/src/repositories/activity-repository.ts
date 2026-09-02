import { localTimeSourceSchema } from "@dofek/format/record-local-time";
import { mapHrZones, mapPowerZones } from "@dofek/zones/zones";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { AccessWindow } from "../billing/entitlement.ts";
import { BaseRepository } from "../lib/base-repository.ts";
import {
  postgresCurrentTimestampRangeLowerBound,
  postgresEndDateTimestampRangeLowerBound,
  type RangeDays,
} from "../lib/date-window.ts";
import { osmTilePreview } from "../lib/osm-tile.ts";
import { dateStringSchema, timestampStringSchema } from "../lib/typed-sql.ts";
import type { ActivityRow } from "../models/activity.ts";
import { activitySourceSchema } from "../models/activity-source.ts";
import { activityMeasurementState } from "../services/activity-data-state.ts";
import { getActivityRoutePreviews } from "./activity-route-preview.ts";

// ---------------------------------------------------------------------------
// Zod schemas for raw DB rows
// ---------------------------------------------------------------------------

const activityListRowSchema = z.object({
  id: z.string(),
  canonical_type: z.string(),
  provider_type: z.string(),
  modality: z.string().nullable().optional().default(null),
  started_at: timestampStringSchema,
  ended_at: timestampStringSchema.nullable(),
  name: z.string().nullable(),
  provider_id: z.string(),
  timezone: z.string().nullable(),
  start_utc_offset_minutes: z.coerce.number().nullable(),
  end_utc_offset_minutes: z.coerce.number().nullable(),
  local_time_source: localTimeSourceSchema,
  source_providers: z.array(z.string()),
  member_activity_ids: z.array(z.string()).optional().default([]),
  avg_hr: z.number().nullable(),
  max_hr: z.number().nullable(),
  avg_power: z.number().nullable(),
  distance_meters: z.number().nullable(),
  elevation_gain_m: z.number().nullable().default(null),
  total_count: z.coerce.number(),
});

const activityListColumns = sql`
  a.id,
  a.canonical_type,
  a.provider_type,
  a.modality::text AS modality,
  a.started_at::text AS started_at,
  a.ended_at::text AS ended_at,
  a.name,
  a.provider_id,
  a.timezone,
  a.start_utc_offset_minutes,
  a.end_utc_offset_minutes,
  a.local_time_source,
  a.source_providers,
  a.member_activity_ids,
  NULL::double precision AS avg_hr,
  NULL::smallint AS max_hr,
  NULL::double precision AS avg_power,
  NULL::double precision AS distance_meters,
  NULL::double precision AS elevation_gain_m,
  COUNT(*) OVER()::int AS total_count
`;

const activityDetailRowSchema = z.object({
  id: z.string(),
  canonical_type: z.string(),
  raw_type: z.string(),
  modality: z.string().nullable().optional().default(null),
  started_at: timestampStringSchema,
  ended_at: timestampStringSchema.nullable(),
  name: z.string().nullable(),
  notes: z.string().nullable(),
  perceived_exertion: z.number().nullable(),
  provider_id: z.string(),
  timezone: z.string().nullable(),
  start_utc_offset_minutes: z.coerce.number().nullable(),
  end_utc_offset_minutes: z.coerce.number().nullable(),
  local_time_source: localTimeSourceSchema,
  subsource: z.string().nullable(),
  source_providers: z.array(z.string()),
  source_external_ids: z.array(activitySourceSchema).nullable(),
  absent_source_external_ids: z.array(activitySourceSchema).nullable().default(null),
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
  provider_absent_at: timestampStringSchema.nullable().optional().default(null),
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

export interface ActivitySensorQueryOptions {
  priority?: "dashboard";
  abortSignal?: AbortSignal | undefined;
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
    options?: ActivitySensorQueryOptions,
  ): Promise<z.infer<TSchema>[]>;
  getActivitySummaries(
    activityIds: string[],
  ): Promise<z.infer<typeof activitySummaryReadModelRowSchema>[]>;
  getPowerCurveSamples(
    days: number | null,
    userId: string,
    timezone: string,
    activityTypes: readonly string[],
  ): Promise<z.infer<typeof powerCurveSampleSchema>[]>;
  getNormalizedPowerSamples(
    days: number | null,
    userId: string,
    timezone: string,
    activityTypes: readonly string[],
  ): Promise<z.infer<typeof normalizedPowerSampleSchema>[]>;
  getVo2MaxEstimates(
    endDate: string,
    days: number,
    userId: string,
    timezone: string,
  ): Promise<z.infer<typeof vo2MaxEstimateSchema>[]>;
  getHeartRateCurveRows(
    days: RangeDays,
    userId: string,
    timezone: string,
  ): Promise<Array<{ duration_seconds: number; best_hr: number; activity_date: string }>>;
  getPaceCurveRows(
    days: RangeDays,
    userId: string,
    timezone: string,
  ): Promise<Array<{ duration_seconds: number; best_pace: number; activity_date: string }>>;
  getStream(window: ActivitySensorWindow, maxPoints: number): Promise<StreamPointRow[]>;
  getHeartRateZoneSeconds(window: ActivitySensorWindow): Promise<z.infer<typeof hrZoneRowSchema>[]>;
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
  days: RangeDays;
  endDate: string;
  limit: number;
  offset: number;
  activityTypes?: string[];
}

export interface SearchInput {
  startDate: string;
  endDate: string;
  query?: string;
  limit: number;
}

export interface CountVisibleInWindowInput {
  days: RangeDays;
  activityTypes?: string[];
  requireEndedAt?: boolean;
  accessWindow?: AccessWindow;
}

function readActivityId(row: unknown): string {
  if (typeof row === "object" && row !== null && "id" in row) {
    const { id } = row;
    if (typeof id === "string") {
      return id;
    }
  }
  throw new Error("Activity row is missing a string id");
}

/** Factory for repositories that need activity visibility helpers without a sensor store. */
export function activityRepositoryFor(
  db: Pick<import("dofek/db").Database, "execute">,
  userId: string,
  timezone = "UTC",
  accessWindow: AccessWindow = { kind: "full", paid: true, reason: "paid_grant" },
): ActivityRepository {
  return new ActivityRepository(db, userId, timezone, accessWindow);
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

  /** Returns activity IDs currently visible in fitness.v_activity. */
  async resolveVisibleActivityIds(activityIds: readonly string[]): Promise<Set<string>> {
    const uniqueActivityIds = [...new Set(activityIds)];
    if (uniqueActivityIds.length === 0) {
      return new Set();
    }

    const activityIdFilter = sql.join(
      uniqueActivityIds.map((activityId) => sql`${activityId}::uuid`),
      sql`, `,
    );
    const rows = await this.query(
      z.object({ id: z.string() }),
      sql`SELECT id::text AS id
          FROM fitness.v_activity
          WHERE user_id = ${this.userId}::uuid
            AND id IN (${activityIdFilter})
            ${this.timestampAccessPredicate(sql`started_at`)}`,
    );
    return new Set(rows.map((row) => row.id));
  }

  /** Returns visible canonical activity IDs since an inclusive local calendar date. */
  async listVisibleActivityIdsSince(localDate: string): Promise<string[]> {
    return this.#listVisibleActivityIdsInRange(localDate);
  }

  /** Returns visible canonical activity IDs in a half-open local calendar range. */
  async listVisibleActivityIdsInRange(
    localStartDate: string,
    localEndDateExclusive: string,
  ): Promise<string[]> {
    return this.#listVisibleActivityIdsInRange(localStartDate, localEndDateExclusive);
  }

  async #listVisibleActivityIdsInRange(
    localStartDate: string,
    localEndDateExclusive?: string,
  ): Promise<string[]> {
    const endDatePredicate = localEndDateExclusive
      ? sql`AND started_at < (${localEndDateExclusive}::date AT TIME ZONE ${this.timezone})`
      : sql``;
    const rows = await this.query(
      z.object({ id: z.string() }),
      sql`SELECT id::text AS id
          FROM fitness.v_activity
          WHERE user_id = ${this.userId}::uuid
            AND started_at >= (${localStartDate}::date AT TIME ZONE ${this.timezone})
            ${endDatePredicate}
            ${this.timestampAccessPredicate(sql`started_at`)}
          ORDER BY started_at DESC`,
    );
    return rows.map((row) => row.id);
  }

  /** Drops rows whose ids are not currently visible in fitness.v_activity. */
  async filterToVisibleActivities<T extends { id: string }>(rows: readonly T[]): Promise<T[]>;
  async filterToVisibleActivities<T>(
    rows: readonly T[],
    getActivityId: (row: T) => string,
  ): Promise<T[]>;
  async filterToVisibleActivities<T>(
    rows: readonly T[],
    getActivityId: (row: T) => string = readActivityId,
  ): Promise<T[]> {
    const visibleActivityIds = await this.resolveVisibleActivityIds(rows.map(getActivityId));
    return rows.filter((row) => visibleActivityIds.has(getActivityId(row)));
  }

  /**
   * Filters rows whose IDs are already canonicalized by the ClickHouse activity
   * read model without expanding the recursive PostgreSQL visibility view.
   */
  async filterToVisibleCanonicalActivities<T extends { id: string }>(
    rows: readonly T[],
  ): Promise<T[]> {
    const uniqueActivityIds = [...new Set(rows.map(readActivityId))];
    if (uniqueActivityIds.length === 0) {
      return [];
    }

    const activityIdFilter = sql.join(
      uniqueActivityIds.map((activityId) => sql`${activityId}::uuid`),
      sql`, `,
    );
    const visibleRows = await this.query(
      z.object({ id: z.string() }),
      sql`SELECT id::text AS id
          FROM fitness.activity
          WHERE user_id = ${this.userId}::uuid
            AND id IN (${activityIdFilter})
            AND provider_absent_at IS NULL
            AND deleted_at IS NULL
            ${this.timestampAccessPredicate(sql`started_at`)}`,
    );
    const visibleActivityIds = new Set(visibleRows.map((row) => row.id));
    return rows.filter((row) => visibleActivityIds.has(row.id));
  }

  /** Counts visible activities in fitness.v_activity for the requested window. */
  async countVisibleInWindow(input: CountVisibleInWindowInput): Promise<number> {
    const activityTypePredicate =
      input.activityTypes && input.activityTypes.length > 0
        ? sql`AND canonical_type IN (${sql.join(
            input.activityTypes.map((activityType) => sql`${activityType}`),
            sql`, `,
          )})`
        : sql``;
    const endedAtPredicate = input.requireEndedAt ? sql`AND ended_at IS NOT NULL` : sql``;
    const accessWindow = input.accessWindow ?? this.accessWindow;
    const accessWindowPredicate = this.timestampAccessPredicate(sql`started_at`, accessWindow);
    const dateWindowPredicate = postgresCurrentTimestampRangeLowerBound(
      input.days,
      sql`started_at`,
    );

    const rows = await this.query(
      z.object({ activity_count: z.coerce.number() }),
      sql`SELECT count(*)::int AS activity_count
          FROM fitness.v_activity
          WHERE user_id = ${this.userId}::uuid
            ${dateWindowPredicate}
            ${endedAtPredicate}
            ${activityTypePredicate}
            ${accessWindowPredicate}`,
    );
    return rows[0]?.activity_count ?? 0;
  }

  /** Paginated activity list with summary metrics. */
  async list(
    input: ListInput,
  ): Promise<{ items: Array<Record<string, unknown>>; totalCount: number }> {
    const rows = await this.#listRawRows(input);
    const hydratedRows = await this.#withActivitySummaries(rows);
    const totalCount = hydratedRows.length > 0 ? (hydratedRows[0]?.total_count ?? 0) : 0;
    const items = hydratedRows.map((row) => this.#toListItem(row));
    return { items, totalCount };
  }

  /** Activities inside an exact inclusive local-date range, optionally filtered before paging. */
  async search(
    input: SearchInput,
  ): Promise<{ items: Array<Record<string, unknown>>; totalCount: number }> {
    const escapedQuery = input.query?.replace(/[%_\\]/g, (character) => `\\${character}`);
    const queryPattern = escapedQuery ? `%${escapedQuery}%` : null;
    const rows = await this.#exactRangeRows(
      input.startDate,
      input.endDate,
      undefined,
      queryPattern,
      input.limit,
    );
    const hydratedRows = await this.#withActivitySummaries(rows);
    const totalCount = hydratedRows[0]?.total_count ?? 0;
    const items = hydratedRows.map((row) => this.#toListItem(row));
    return { items, totalCount };
  }

  /** All activities inside an exact inclusive local-date range for server-side aggregation. */
  async listRange(
    startDate: string,
    endDate: string,
    activityTypes?: string[],
  ): Promise<Array<Record<string, unknown>>> {
    const rows = await this.#exactRangeRows(startDate, endDate, activityTypes);
    const hydratedRows = await this.#withActivitySummaries(rows);
    return hydratedRows.map((row) => this.#toListItem(row));
  }

  #toListItem<
    TRow extends {
      distance_meters: number | null;
      elevation_gain_m: number | null;
      provider_type: string;
      total_count?: number;
      member_activity_ids?: string[];
    },
  >(row: TRow) {
    const { total_count: _totalCount, member_activity_ids: _memberActivityIds, ...rest } = row;
    return {
      ...rest,
      raw_type: row.provider_type,
      distance_state: activityMeasurementState("Distance", row.distance_meters),
      elevation_state: activityMeasurementState("Elevation gain", row.elevation_gain_m),
    };
  }

  #exactRangeRows(
    startDate: string,
    endDate: string,
    activityTypes?: string[],
    queryPattern: string | null = null,
    limit?: number,
  ) {
    const typeFilter =
      activityTypes && activityTypes.length > 0
        ? sql`AND a.canonical_type IN (${sql.join(
            activityTypes.map((activityType) => sql`${activityType}`),
            sql`, `,
          )})`
        : sql``;
    const queryFilter = queryPattern
      ? sql`AND (a.name ILIKE ${queryPattern} OR a.canonical_type::text ILIKE ${queryPattern})`
      : sql``;
    const limitClause = limit == null ? sql`` : sql`LIMIT ${limit}`;
    return this.query(
      activityListRowSchema,
      sql`SELECT
            ${activityListColumns}
          FROM fitness.v_activity a
          WHERE a.user_id = ${this.userId}
            AND a.started_at >= (${startDate}::date AT TIME ZONE ${this.timezone})
            AND a.started_at < ((${endDate}::date + 1) AT TIME ZONE ${this.timezone})
            ${typeFilter}
            ${queryFilter}
            ${this.timestampAccessPredicate(sql`a.started_at`)}
          ORDER BY a.started_at DESC
          ${limitClause}`,
    );
  }

  #listRawRows(input: ListInput) {
    const typeFilter =
      input.activityTypes && input.activityTypes.length > 0
        ? sql`AND a.canonical_type IN (${sql.join(
            input.activityTypes.map((type) => sql`${type}`),
            sql`, `,
          )})`
        : sql``;
    const rangeFilter = postgresEndDateTimestampRangeLowerBound(
      input.days,
      sql`a.started_at`,
      input.endDate,
    );
    return this.query(
      activityListRowSchema,
      sql`SELECT
            ${activityListColumns}
          FROM fitness.v_activity a
          WHERE a.user_id = ${this.userId}
            ${rangeFilter}
            ${typeFilter}
            ${this.timestampAccessPredicate(sql`a.started_at`)}
          ORDER BY a.started_at DESC
          LIMIT ${input.limit} OFFSET ${input.offset}`,
    );
  }

  /** Single activity with full detail row. Returns null when not found. */
  async findById(activityId: string): Promise<ActivityRow | null> {
    const activeRow = await this.#findActiveById(activityId);
    if (activeRow) {
      return activeRow;
    }
    return this.#findProviderAbsentById(activityId);
  }

  async #findActiveById(activityId: string): Promise<ActivityRow | null> {
    const rows = await this.query(
      activityDetailRowSchema,
      sql`SELECT
            a.id,
            a.canonical_type,
            a.provider_type AS raw_type,
            a.modality::text AS modality,
            a.started_at::text AS started_at,
            a.ended_at::text AS ended_at,
            a.name,
            a.notes,
            a.perceived_exertion,
            a.provider_id,
            a.timezone,
            a.start_utc_offset_minutes,
            a.end_utc_offset_minutes,
            a.local_time_source,
            a.raw->>'sourceName' AS subsource,
            a.source_providers,
            a.source_external_ids,
            a.absent_source_external_ids,
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
            NULL::integer AS sample_count,
            NULL::text AS provider_absent_at
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

  async #findProviderAbsentById(activityId: string): Promise<ActivityRow | null> {
    const rows = await this.query(
      activityDetailRowSchema,
      sql`SELECT
            a.id,
            a.canonical_type,
            a.provider_type AS raw_type,
            a.modality::text AS modality,
            a.started_at::text AS started_at,
            a.ended_at::text AS ended_at,
            a.name,
            a.notes,
            a.perceived_exertion,
            a.provider_id,
            CASE
              WHEN a.local_time_source IN ('provider_timezone', 'device_timezone', 'user_home_timezone')
              THEN a.timezone
              ELSE NULL
            END AS timezone,
            CASE
              WHEN a.local_time_source <> 'unknown' THEN a.start_utc_offset_minutes
              ELSE NULL
            END AS start_utc_offset_minutes,
            CASE
              WHEN a.local_time_source <> 'unknown' THEN a.end_utc_offset_minutes
              ELSE NULL
            END AS end_utc_offset_minutes,
            a.local_time_source,
            a.raw->>'sourceName' AS subsource,
            ARRAY[a.provider_id] AS source_providers,
            NULL::jsonb AS source_external_ids,
            CASE
              WHEN a.external_id IS NOT NULL AND a.external_id <> ''
              THEN jsonb_build_array(
                jsonb_build_object(
                  'providerId', a.provider_id,
                  'externalId', a.external_id,
                  'memberActivityId', a.id::text,
                  'providerAbsentAt', a.provider_absent_at,
                  'subsource', COALESCE(
                    NULLIF(trim(a.raw->>'sourceName'), ''),
                    NULLIF(trim(a.source_name), '')
                  )
                )
              )
              ELSE NULL
            END AS absent_source_external_ids,
            ARRAY[a.id]::uuid[] AS member_activity_ids,
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
            NULL::integer AS sample_count,
            a.provider_absent_at::text AS provider_absent_at
          FROM fitness.activity a
          WHERE a.id = ${activityId}::uuid
            AND a.user_id = ${this.userId}::uuid
            AND a.provider_absent_at IS NOT NULL
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
                mapPreview:
                  routePreview ??
                  osmTilePreview([{ lat: summary.centroid_lat, lng: summary.centroid_lng }]),
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
    return mapHrZones(await sensorStore.getHeartRateZoneSeconds(window));
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

  async getActivityMemberIds(activityId: string): Promise<string[] | null> {
    const window = await this.#findActivitySensorWindow(activityId);
    if (!window) return null;
    return window.memberActivityIds;
  }

  /** Delete an activity by ID. */
  async delete(activityId: string): Promise<void> {
    await this.bulkDelete([activityId]);
  }

  /** Clear provider tombstones so hidden activities become visible again. */
  async restoreProviderAbsent(activityIds: string[]): Promise<{ restoredCount: number }> {
    const uniqueActivityIds = [...new Set(activityIds)];
    if (uniqueActivityIds.length === 0) {
      return { restoredCount: 0 };
    }

    const restoredRows = await this.query(
      z.object({ id: z.string() }),
      sql`UPDATE fitness.activity
          SET provider_absent_at = NULL
          WHERE user_id = ${this.userId}::uuid
            AND provider_absent_at IS NOT NULL
            AND id IN (${sql.join(
              uniqueActivityIds.map((activityId) => sql`${activityId}::uuid`),
              sql`, `,
            )})
          RETURNING id::text AS id`,
    );
    return { restoredCount: restoredRows.length };
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
      UPDATE fitness.activity
      SET deleted_at = NOW()
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
      AND deleted_at IS NULL
    `);
    return { deletedCount: uniqueActivityIds.length, memberActivityIds };
  }
}
