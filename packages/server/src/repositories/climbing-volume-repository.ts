import { formatDateYmdInTimeZone } from "@dofek/format/format";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { BaseRepository } from "../lib/base-repository.ts";
import { dateWindowStartString } from "../lib/date-window.ts";
import {
  type ClimbingVolumeIncrease,
  climbingVolumeWindowDays,
  evaluateClimbingVolumeIncrease,
} from "./climbing-volume-increase.ts";

const workoutSchema = z.object({
  daysAgo: z
    .number()
    .int()
    .min(0)
    .max(climbingVolumeWindowDays - 1),
  durationMicroseconds: z.coerce.number().int().nullable(),
});

export class ClimbingVolumeRepository extends BaseRepository {
  async getIncrease(now = new Date()): Promise<ClimbingVolumeIncrease> {
    const today = formatDateYmdInTimeZone(now, this.timezone);
    const startDate = dateWindowStartString(today, climbingVolumeWindowDays - 1);
    if (
      this.accessWindow.kind === "limited" &&
      (this.accessWindow.startDate > startDate || this.accessWindow.endDateExclusive <= today)
    ) {
      return { status: "insufficient_data" };
    }

    const startDay = sql`(climbing.started_at AT TIME ZONE ${this.timezone})::date`;
    const asOf = now.toISOString();
    const workouts = await this.query(
      workoutSchema,
      sql`SELECT ${today}::date - ${startDay} AS "daysAgo",
          EXTRACT(EPOCH FROM (climbing.ended_at - climbing.started_at)) * 1000000
            AS "durationMicroseconds"
        FROM fitness.v_activity_group AS climbing
        WHERE climbing.user_id = ${this.userId}
          AND climbing.canonical_type = 'climbing'
          AND ${startDay} BETWEEN ${startDate}::date AND ${today}::date
          AND climbing.started_at <= ${asOf}::timestamptz
          AND (climbing.ended_at IS NULL OR climbing.ended_at <= ${asOf}::timestamptz)
          AND EXISTS (
            SELECT 1 FROM fitness.activity AS member
            WHERE member.id = ANY(climbing.member_activity_ids)
              AND member.user_id = climbing.user_id
              AND member.provider_type <> 'climbing_log'
              AND member.provider_absent_at IS NULL
              AND member.deleted_at IS NULL
          )`,
    );
    return evaluateClimbingVolumeIncrease(workouts);
  }
}
