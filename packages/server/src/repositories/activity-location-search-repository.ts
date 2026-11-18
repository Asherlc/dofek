import { TRPCError } from "@trpc/server";
import type { Database } from "dofek/db";
import { captureException } from "dofek/lib/error-reporting";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { AccessWindow } from "../billing/entitlement.ts";
import { BaseRepository } from "../lib/base-repository.ts";
import {
  clickHouseActivityCalendarDate,
  postgresActivityCalendarDate,
} from "./activity-local-date.ts";
import type { ActivitySensorQueryStore } from "./activity-sensor-types.ts";

export const activityLocationCursorSchema = z.object({
  id: z.uuid(),
  startedAt: z.iso.datetime(),
});

type LocationCursor = z.infer<typeof activityLocationCursorSchema>;
type ActivityLocationSearch =
  | { kind: "name"; name: string }
  | { kind: "nearby"; latitude: number; longitude: number };

const nearbyDistanceMeters = 25_000;

export class ActivityLocationSearchRepository extends BaseRepository {
  readonly #sensorStore: ActivitySensorQueryStore;

  constructor(
    db: Pick<Database, "execute">,
    userId: string,
    timezone: string,
    sensorStore: ActivitySensorQueryStore,
    accessWindow: AccessWindow,
  ) {
    super(db, userId, timezone, accessWindow);
    this.#sensorStore = sensorStore;
  }

  findCandidates({
    location,
    activityType,
    after,
    limit,
  }: {
    location: ActivityLocationSearch;
    activityType?: string;
    after?: LocationCursor;
    limit: number;
  }): Promise<LocationCursor[]> {
    return location.kind === "name"
      ? this.#findNamedAreas(location.name, activityType, after, limit)
      : this.#findNearbyRoutes(location, activityType, after, limit);
  }

  #findNamedAreas(
    name: string,
    activityType: string | undefined,
    after: LocationCursor | undefined,
    limit: number,
  ) {
    const sport = activityType
      ? sql`AND coalesce(grouped.primary_canonical_type, grouped.canonical_type::text) = ${activityType}`
      : sql``;
    const cursor = after
      ? sql`AND (grouped.started_at, grouped.id) < (${after.startedAt}::timestamptz, ${after.id}::uuid)`
      : sql``;
    return this.query(
      activityLocationCursorSchema,
      sql`
      SELECT grouped.id::text AS id,
             to_char(grouped.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "startedAt"
      FROM fitness.v_activity AS grouped
      WHERE grouped.user_id = ${this.userId}::uuid
        AND (grouped.ended_at IS NOT NULL OR grouped.provider_type = 'climbing_log')
        ${this.dateAccessPredicate(postgresActivityCalendarDate(sql`grouped`, this.timezone))}
        ${sport}
        ${cursor}
        AND EXISTS (
          SELECT 1
          FROM fitness.v_climbing_log_entry AS entry
          CROSS JOIN LATERAL jsonb_array_elements(entry.area_path) AS area(location)
          WHERE entry.user_id = grouped.user_id
            AND entry.activity_id = ANY(grouped.member_activity_ids)
            AND entry.provider_absent_at IS NULL
            AND strpos(lower(area.location ->> 'name'), lower(${name})) > 0
        )
      ORDER BY grouped.started_at DESC, grouped.id DESC
      LIMIT ${limit}
    `,
    ).catch((error: unknown) => {
      // Drizzle includes bound parameters in the error message.
      const cause = error instanceof Error ? error.cause : undefined;
      const code =
        cause instanceof Error && "code" in cause && typeof cause.code === "string"
          ? cause.code
          : undefined;
      captureException(new Error("Named activity location search failed."), {
        tags: { dependency: "postgres", databaseCode: code },
      });
      throw new TRPCError({
        code: "SERVICE_UNAVAILABLE",
        message: "Location search is temporarily unavailable.",
      });
    });
  }

  #findNearbyRoutes(
    { latitude, longitude }: Extract<ActivityLocationSearch, { kind: "nearby" }>,
    activityType: string | undefined,
    after: LocationCursor | undefined,
    limit: number,
  ) {
    const activityDate = clickHouseActivityCalendarDate("activity");
    const access =
      this.accessWindow.kind === "limited"
        ? `AND ${activityDate} >= {startDate:Date} AND ${activityDate} < {endDateExclusive:Date}`
        : "";
    const sport = activityType
      ? "AND coalesce(activity.primary_canonical_type, activity.canonical_type) = {activityType:String}"
      : "";
    const cursor = after
      ? "AND (activity.started_at, activity.activity_id) < (parseDateTime64BestEffort({cursorStartedAt:String}, 6, 'UTC'), {cursorId:UUID})"
      : "";
    return this.#sensorStore.query(
      activityLocationCursorSchema,
      `
      SELECT toString(activity.activity_id) AS id,
             formatDateTime(activity.started_at, '%FT%T.%fZ', 'UTC') AS startedAt
      FROM analytics.deduped_activities AS activity FINAL
      INNER JOIN analytics.activity_summary AS summary
        ON summary.user_id = activity.user_id AND summary.activity_id = activity.activity_id
      WHERE activity.user_id = {userId:UUID}
        AND activity.is_deleted = 0
        AND (activity.ended_at IS NOT NULL OR activity.provider_type = 'climbing_log')
        AND geoDistance({longitude:Float64}, {latitude:Float64}, summary.centroid_lng, summary.centroid_lat)
            <= {distance:UInt32}
        ${access}
        ${sport}
        ${cursor}
      ORDER BY activity.started_at DESC, activity.activity_id DESC
      LIMIT {limit:UInt32}
    `,
      {
        userId: this.userId,
        latitude,
        longitude,
        distance: nearbyDistanceMeters,
        limit,
        ...(this.accessWindow.kind === "limited"
          ? {
              timezone: this.timezone,
              startDate: this.accessWindow.startDate,
              endDateExclusive: this.accessWindow.endDateExclusive,
            }
          : {}),
        ...(activityType ? { activityType } : {}),
        ...(after ? { cursorStartedAt: after.startedAt, cursorId: after.id } : {}),
      },
    );
  }
}
