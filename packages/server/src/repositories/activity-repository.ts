import { mapHrZones, mapPowerZones } from "@dofek/zones/zones";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { BaseRepository } from "../lib/base-repository.ts";
import { timestampWindowStart } from "../lib/date-window.ts";
import { sqlFileTemplate } from "../lib/sql-file.ts";
import { restingHeartRateLateral } from "../lib/sql-fragments.ts";
import { timestampStringSchema } from "../lib/typed-sql.ts";
import type { ActivityRow } from "../models/activity.ts";

const activityListSql = sqlFileTemplate("./sql/activity-list.sql", import.meta.url);
const activityDetailSql = sqlFileTemplate("./sql/activity-detail.sql", import.meta.url);
const activityStreamSql = sqlFileTemplate("./sql/activity-stream.sql", import.meta.url);
const hrZonesSql = sqlFileTemplate("./sql/hr-zones.sql", import.meta.url);
const powerZonesSql = sqlFileTemplate("./sql/power-zones.sql", import.meta.url);

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
      activityListSql({
        userId: sql`${this.userId}`,
        startedAfter: sql`${timestampWindowStart(input.endDate, input.days)}`,
        typeFilter,
        accessPredicate: this.timestampAccessPredicate(sql`a.started_at`),
        limit: sql`${input.limit}`,
        offset: sql`${input.offset}`,
      }),
    );
  }

  /** Single activity with full detail row. Returns null when not found. */
  async findById(activityId: string): Promise<ActivityRow | null> {
    const rows = await this.query(
      activityDetailRowSchema,
      activityDetailSql({
        activityId: sql`${activityId}`,
        userId: sql`${this.userId}`,
        accessPredicate: this.timestampAccessPredicate(sql`a.started_at`),
      }),
    );
    return rows[0] ?? null;
  }

  /** Downsampled metric stream for a single activity. */
  async getStream(activityId: string, maxPoints: number): Promise<StreamPoint[]> {
    const rows = await this.query(
      streamPointRowSchema,
      activityStreamSql({
        activityId: sql`${activityId}`,
        userId: sql`${this.userId}`,
        accessPredicate: this.timestampAccessPredicate(sql`a.started_at`),
        maxPoints: sql`${maxPoints}`,
      }),
    );

    return rows.map((row) => new StreamPoint(row));
  }

  /** HR zone distribution for a single activity using Karvonen zones. */
  async getHrZones(activityId: string): Promise<import("@dofek/zones/zones").ActivityHrZone[]> {
    const rows = await this.query(
      hrZoneRowSchema,
      hrZonesSql({
        restingHeartRateLateral: restingHeartRateLateral(
          sql`up.id`,
          sql`(SELECT (a.started_at AT TIME ZONE ${this.timezone})::date FROM fitness.v_activity a WHERE a.id = ${activityId} AND a.user_id = ${this.userId})`,
        ),
        userId: sql`${this.userId}`,
        activityId: sql`${activityId}`,
        accessPredicate: this.timestampAccessPredicate(sql`a.started_at`),
      }),
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
      powerZonesSql({
        activityId: sql`${activityId}`,
        userId: sql`${this.userId}`,
        accessPredicate: this.timestampAccessPredicate(sql`a.started_at`),
        ftp: sql`${ftp}`,
      }),
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
