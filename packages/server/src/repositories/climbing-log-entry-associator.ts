import { isClimbingLogActivity } from "@dofek/training/climbing-log";
import { TRPCError } from "@trpc/server";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { ClimbingLogEntryDetail } from "../contracts/climbing-log-contracts.ts";
import { BaseRepository } from "../lib/base-repository.ts";
import { ActivityRepository } from "./activity-repository.ts";
import { ClimbingActivityLogEntryRepository } from "./climbing-activity-log-entry-repository.ts";

export class ClimbingLogEntryAssociator extends BaseRepository {
  async #activity(activityId: string) {
    const activity = await new ActivityRepository(
      this.db,
      this.userId,
      this.timezone,
      this.accessWindow,
    ).findById(activityId);
    if (!activity) throw new TRPCError({ code: "NOT_FOUND", message: "Activity not found." });
    if (!isClimbingLogActivity(activity.canonical_type))
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "Choose a climbing or hiking activity to attach this climbing log.",
      });
    return activity;
  }
  async getSuggestions(activityId: string): Promise<ClimbingLogEntryDetail[]> {
    const activity = await this.#activity(activityId);
    return new ClimbingActivityLogEntryRepository(
      this.db,
      this.userId,
      this.timezone,
      this.accessWindow,
    ).getUnattachedLogEntriesForDate(activity.displayed_date);
  }
  async attachLogEntry(input: { climbingLogEntryId: string; activityId: string }): Promise<void> {
    const activity = await this.#activity(input.activityId);
    const updated = await this.query(
      z.object({ id: z.guid() }),
      sql`
      WITH eligible_activity AS (
        SELECT member.id FROM fitness.activity_group AS activity_group
        JOIN fitness.activity AS member ON member.user_id=activity_group.user_id AND member.group_id=activity_group.id
        WHERE activity_group.user_id=${this.userId}::uuid AND activity_group.id=${activity.id}::uuid
          AND member.canonical_type IN ('climbing','hiking') AND member.deleted_at IS NULL AND member.provider_absent_at IS NULL
        ORDER BY (member.id=activity_group.anchor_activity_id) DESC,member.started_at,member.id LIMIT 1
      )
      UPDATE fitness.climbing_log_entry SET activity_id=(SELECT id FROM eligible_activity)
      WHERE id=${input.climbingLogEntryId}::uuid AND user_id=${this.userId}::uuid AND provider_absent_at IS NULL
        AND activity_id IS NULL AND climbed_on=${activity.displayed_date}::date
        AND EXISTS(SELECT 1 FROM eligible_activity)
      RETURNING id::text AS id
    `,
    );
    if (!updated.length)
      throw new TRPCError({
        code: "CONFLICT",
        message:
          "This climbing log is no longer available for that activity. Refresh the activity and choose an active log from the same day.",
      });
  }
}
