import { sql } from "drizzle-orm";
import { z } from "zod";
import type { AccessWindow } from "../billing/entitlement.ts";
import type { ActivityLocation } from "../contracts/activity-location.ts";
import { BaseRepository } from "../lib/base-repository.ts";
import {
  postgresCurrentTimestampRangeLowerBound,
  postgresEndDateTimestampRangeLowerBound,
  type RangeDays,
} from "../lib/date-window.ts";
import { activityMeasurementState } from "../services/activity-data-state.ts";
import { activityListColumns, activityListRowSchema } from "./activity-repository-schemas.ts";
import type { ActivitySensorReadStore } from "./activity-sensor-types.ts";
import { withActivitySummaries } from "./activity-summary-enrichment.ts";

export type ActivityListItem = Record<string, unknown> & {
  location: ActivityLocation | null;
  primary_canonical_type: string | null;
};

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
  cursor?: string;
  compact?: boolean;
  provider?: string;
  canonicalType?: string;
}

export interface CountVisibleInWindowInput {
  days: RangeDays;
  activityTypes?: string[];
  requireEndedAt?: boolean;
  accessWindow?: AccessWindow;
}

export class ActivityListRepository extends BaseRepository {
  readonly #sensorStore?: ActivitySensorReadStore;

  constructor(
    db: Pick<import("dofek/db").Database, "execute">,
    userId: string,
    timezone: string,
    accessWindow: AccessWindow,
    sensorStore?: ActivitySensorReadStore,
  ) {
    super(db, userId, timezone, accessWindow);
    this.#sensorStore = sensorStore;
  }

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

  async list(input: ListInput): Promise<{ items: ActivityListItem[]; totalCount: number }> {
    const rows = await this.#listRawRows(input);
    const hydratedRows = await withActivitySummaries(rows, this.#sensorStore, this.userId);
    const totalCount = hydratedRows.length > 0 ? (hydratedRows[0]?.total_count ?? 0) : 0;
    return { items: hydratedRows.map((row) => this.#toListItem(row)), totalCount };
  }

  async search(input: SearchInput) {
    const escapedQuery = input.query?.replace(/[%_\\]/g, (character) => `\\${character}`);
    const queryPattern = escapedQuery ? `%${escapedQuery}%` : null;
    const options = {
      startDate: input.startDate,
      endDate: input.endDate,
      queryPattern,
      limit: input.limit + 1,
      cursor: input.cursor,
      provider: input.provider,
      canonicalType: input.canonicalType,
    };
    const rows = await this.#exactRangeRows(options);
    const page = rows.slice(0, input.limit);
    const hydratedRows = input.compact
      ? page.map((row) => ({ ...row, location: null }))
      : await withActivitySummaries(page, this.#sensorStore, this.userId);
    const totalCount =
      rows[0]?.total_count ??
      (input.cursor
        ? ((await this.#exactRangeRows({ ...options, cursor: undefined, limit: 1 }))[0]
            ?.total_count ?? 0)
        : 0);
    return {
      items: hydratedRows.map((row) => this.#toListItem(row)),
      totalCount,
      nextCursor: rows.length > input.limit ? (page.at(-1)?.id ?? null) : null,
    };
  }

  async listRange(
    startDate: string,
    endDate: string,
    activityTypes?: string[],
  ): Promise<ActivityListItem[]> {
    const rows = await this.#exactRangeRows({ startDate, endDate, activityTypes });
    const hydratedRows = await withActivitySummaries(rows, this.#sensorStore, this.userId);
    return hydratedRows.map((row) => this.#toListItem(row));
  }

  #toListItem<
    TRow extends {
      distance_meters: number | null;
      elevation_gain_m: number | null;
      provider_type: string;
      primary_canonical_type: string | null;
      total_count?: number;
      member_activity_ids?: string[];
      location: ActivityLocation | null;
    },
  >(row: TRow): ActivityListItem {
    const { total_count: _totalCount, member_activity_ids: _memberActivityIds, ...rest } = row;
    return {
      avg_hr: null,
      max_hr: null,
      avg_power: null,
      max_power: null,
      avg_speed: null,
      max_speed: null,
      avg_cadence: null,
      total_distance: null,
      elevation_loss_m: null,
      sample_count: null,
      ...rest,
      raw_type: row.provider_type,
      distance_state: activityMeasurementState("Distance", row.distance_meters),
      elevation_state: activityMeasurementState("Elevation gain", row.elevation_gain_m),
    };
  }

  #exactRangeRows({
    startDate,
    endDate,
    activityTypes,
    queryPattern,
    limit,
    cursor,
    provider,
    canonicalType,
  }: {
    startDate: string;
    endDate: string;
    activityTypes?: string[];
    queryPattern?: string | null;
    limit?: number;
    cursor?: string;
    provider?: string;
    canonicalType?: string;
  }) {
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
    const cursorFilter = cursor
      ? sql`WHERE (activity.sort_started_at, activity.id) < (
          SELECT sort_started_at, id FROM filtered_activities WHERE id = ${cursor}::uuid
        )`
      : sql``;
    return this.query(
      activityListRowSchema,
      sql`WITH filtered_activities AS (
            SELECT ${activityListColumns}, a.started_at AS sort_started_at
            FROM fitness.v_activity a
            WHERE a.user_id = ${this.userId}
              AND a.started_at >= (${startDate}::date AT TIME ZONE ${this.timezone})
              AND a.started_at < ((${endDate}::date + 1) AT TIME ZONE ${this.timezone})
              ${typeFilter}
              ${queryFilter}
              ${provider ? sql`AND ${provider} = ANY(a.source_providers)` : sql``}
              ${canonicalType ? sql`AND a.canonical_type::text = ${canonicalType}` : sql``}
              ${this.timestampAccessPredicate(sql`a.started_at`)}
          )
          SELECT activity.*
          FROM filtered_activities activity
          ${cursorFilter}
          ORDER BY activity.sort_started_at DESC, activity.id DESC
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
}
