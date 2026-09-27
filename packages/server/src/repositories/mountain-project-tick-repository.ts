import { TRPCError } from "@trpc/server";
import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { AccessWindow } from "../billing/entitlement.ts";
import { BaseRepository } from "../lib/base-repository.ts";
import { postgresActivityLocalDate } from "./activity-local-date.ts";
import { ActivityRepository } from "./activity-repository.ts";

const suggestionSchema = z.object({
  id: z.string(),
  climb_type: z.enum(["boulder", "route"]),
  grade_system: z.string(),
  grade: z.string(),
  sent: z.boolean().nullable(),
  attempt_count: z.number().nullable(),
  lead: z.boolean().nullable(),
  route_name: z.string().nullable(),
  location_name: z.string().nullable(),
});

export type MountainProjectTickSuggestion = {
  id: string;
  climbType: "boulder" | "route";
  gradeSystem: string;
  grade: string;
  sent: boolean | null;
  attemptCount: number | null;
  lead: boolean | null;
  routeName: string | null;
  locationName: string | null;
};

const updateSchema = z.object({ id: z.string() });

const AUTHORITATIVE_ACTIVITY_DATE_SOURCES = new Set([
  "provider_timezone",
  "device_timezone",
  "user_home_timezone",
  "gps_timezone",
  "home_zone_fallback",
  "provider_offset",
  "device_offset",
]);

function activityDate(
  activity: Awaited<ReturnType<ActivityRepository["findById"]>>,
  timezone: string,
) {
  if (!activity) return null;
  const start = new Date(activity.started_at);
  if (
    activity.start_utc_offset_minutes !== null &&
    activity.start_utc_offset_minutes !== undefined &&
    AUTHORITATIVE_ACTIVITY_DATE_SOURCES.has(activity.local_time_source)
  ) {
    return new Date(start.getTime() + activity.start_utc_offset_minutes * 60_000)
      .toISOString()
      .slice(0, 10);
  }
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(start);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value;
  const year = value("year");
  const month = value("month");
  const day = value("day");
  return year && month && day ? `${year}-${month}-${day}` : null;
}

export class MountainProjectTickRepository extends BaseRepository {
  constructor(
    db: Pick<Database, "execute">,
    userId: string,
    timezone = "UTC",
    accessWindow?: AccessWindow,
  ) {
    super(db, userId, timezone, accessWindow);
  }

  async getSuggestions(activityId: string): Promise<MountainProjectTickSuggestion[]> {
    const activity = await new ActivityRepository(
      this.db,
      this.userId,
      this.timezone,
      this.accessWindow,
    ).findById(activityId);
    if (!activity) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Activity not found." });
    }
    if (activity.canonical_type !== "climbing") {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "Mountain Project ticks can only be matched to a climbing activity.",
      });
    }
    const displayedDate = activityDate(activity, this.timezone);
    if (!displayedDate) return [];

    const rows = await this.query(
      suggestionSchema,
      sql`SELECT id::text AS id, climb_type::text AS climb_type,
                 grade_system::text AS grade_system, grade, sent, attempt_count,
                 lead, route_name, location_name
          FROM fitness.climbing_entry
          WHERE user_id = ${this.userId}::uuid
            AND provider_id = 'mountain-project'
            AND provider_absent_at IS NULL
            AND activity_id IS NULL
            AND unattached_date = ${displayedDate}::date
          ORDER BY location_name NULLS LAST, grade_system, grade, id`,
    );
    return rows.map((row) => ({
      id: row.id,
      climbType: row.climb_type,
      gradeSystem: row.grade_system,
      grade: row.grade,
      sent: row.sent,
      attemptCount: row.attempt_count,
      lead: row.lead,
      routeName: row.route_name,
      locationName: row.location_name,
    }));
  }

  async attachTick(input: { tickId: string; activityId: string }): Promise<void> {
    const activity = await new ActivityRepository(
      this.db,
      this.userId,
      this.timezone,
      this.accessWindow,
    ).findById(input.activityId);
    if (!activity) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Activity not found." });
    }
    if (activity.canonical_type !== "climbing") {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "Choose a climbing activity to attach this tick.",
      });
    }
    const displayedDate = activityDate(activity, this.timezone);
    if (!displayedDate) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "This activity does not have a usable displayed date. Refresh it and try again.",
      });
    }
    const localDate = postgresActivityLocalDate(sql`member`, this.timezone);
    const updated = await this.query(
      updateSchema,
      sql`WITH eligible_activity AS (
            SELECT member.id
            FROM fitness.activity_group AS activity_group
            JOIN fitness.activity AS member
              ON member.user_id = activity_group.user_id
             AND member.group_id = activity_group.id
            WHERE activity_group.user_id = ${this.userId}::uuid
              AND activity_group.id = ${activity.id}::uuid
              AND member.canonical_type = 'climbing'
              AND member.deleted_at IS NULL
              AND member.provider_absent_at IS NULL
              AND (${localDate})::text = ${displayedDate}
            ORDER BY (member.id = activity_group.anchor_activity_id) DESC,
                     member.started_at, member.id
            LIMIT 1
          )
          UPDATE fitness.climbing_entry
          SET activity_id = (SELECT id FROM eligible_activity),
              unattached_date = NULL
          WHERE id = ${input.tickId}::uuid
            AND user_id = ${this.userId}::uuid
            AND provider_id = 'mountain-project'
            AND provider_absent_at IS NULL
            AND activity_id IS NULL
            AND unattached_date = ${displayedDate}::date
            AND EXISTS (SELECT 1 FROM eligible_activity)
          RETURNING id::text AS id`,
    );
    if (updated.length === 0) {
      throw new TRPCError({
        code: "CONFLICT",
        message:
          "This tick is no longer available for that activity. Refresh the activity and choose an active same-day Mountain Project tick.",
      });
    }
  }
}
