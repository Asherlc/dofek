import { TRPCError } from "@trpc/server";
import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { AccessWindow } from "../billing/entitlement.ts";
import { BaseRepository } from "../lib/base-repository.ts";
import { ActivityRepository } from "./activity-repository.ts";

const suggestionSchema = z.object({
  id: z.string(),
  provider_id: z.string(),
  source_name: z.string().nullable(),
  climb_type: z.enum(["boulder", "route"]),
  grade_system: z.string(),
  grade: z.string(),
  sent: z.boolean().nullable(),
  ascent_type: z.enum(["Flash", "Onsight", "Redpoint", "Pinkpoint", "Repeat"]).nullable(),
  attempt_count: z.number().nullable(),
  lead: z.boolean().nullable(),
  route_name: z.string().nullable(),
  location_name: z.string().nullable(),
});

export type ClimbingEntrySuggestion = {
  id: string;
  providerId: string;
  sourceName: string | null;
  climbType: "boulder" | "route";
  gradeSystem: string;
  grade: string;
  sent: boolean | null;
  ascentType: "Flash" | "Onsight" | "Redpoint" | "Pinkpoint" | "Repeat" | null;
  attemptCount: number | null;
  lead: boolean | null;
  routeName: string | null;
  locationName: string | null;
};

const updateSchema = z.object({ id: z.string() });

export class ClimbingEntryAssociator extends BaseRepository {
  constructor(
    db: Pick<Database, "execute">,
    userId: string,
    timezone = "UTC",
    accessWindow?: AccessWindow,
  ) {
    super(db, userId, timezone, accessWindow);
  }

  async getSuggestions(activityId: string): Promise<ClimbingEntrySuggestion[]> {
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
        message: "Climbing entries can only be matched to a climbing activity.",
      });
    }

    const displayedDate = activity.displayed_date;
    const rows = await this.query(
      suggestionSchema,
      sql`SELECT id::text AS id, provider_id, source_name,
                 climb_type::text AS climb_type,
                 grade_system::text AS grade_system, grade, sent, attempt_count,
                 CASE lower(btrim(COALESCE(raw->>'ascentType', raw->>'attemptType',
                   CASE WHEN climb_type = 'boulder'
                     THEN raw->>'Style' ELSE raw->>'Lead Style' END)))
                   WHEN 'flash' THEN 'Flash'
                   WHEN 'onsight' THEN 'Onsight'
                   WHEN 'redpoint' THEN 'Redpoint'
                   WHEN 'pinkpoint' THEN 'Pinkpoint'
                   WHEN 'repeat' THEN 'Repeat'
                   ELSE NULL
                 END AS ascent_type,
                 lead, route_name, location_name
          FROM fitness.climbing_entry
          WHERE user_id = ${this.userId}::uuid
            AND provider_absent_at IS NULL
            AND activity_id IS NULL
            AND unattached_date = ${displayedDate}::date
          ORDER BY location_name NULLS LAST, grade_system, grade, id`,
    );
    return rows.map((row) => ({
      id: row.id,
      providerId: row.provider_id,
      sourceName: row.source_name,
      climbType: row.climb_type,
      gradeSystem: row.grade_system,
      grade: row.grade,
      sent: row.sent,
      ascentType: row.ascent_type,
      attemptCount: row.attempt_count,
      lead: row.lead,
      routeName: row.route_name,
      locationName: row.location_name,
    }));
  }

  async attachEntry(input: { entryId: string; activityId: string }): Promise<void> {
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
        message: "Choose a climbing activity to attach this entry.",
      });
    }
    const displayedDate = activity.displayed_date;
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
            ORDER BY (member.id = activity_group.anchor_activity_id) DESC,
                     member.started_at, member.id
            LIMIT 1
          )
          UPDATE fitness.climbing_entry
          SET activity_id = (SELECT id FROM eligible_activity),
              unattached_date = NULL
          WHERE id = ${input.entryId}::uuid
            AND user_id = ${this.userId}::uuid
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
          "This climbing entry is no longer available for that activity. Refresh the activity and choose an active same-day climbing entry.",
      });
    }
  }
}
