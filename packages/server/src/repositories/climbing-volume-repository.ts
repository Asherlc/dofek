import { formatDateYmdInTimeZone } from "@dofek/format/format";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { BaseRepository } from "../lib/base-repository.ts";
import { dateWindowStartString } from "../lib/date-window.ts";
import { postgresActivityCalendarDate } from "./activity-local-date.ts";
import {
  type ClimbingAttemptIncrease,
  evaluateClimbingAttemptIncrease,
} from "./climbing-attempt-increase.ts";
import { canonicalClimbingLogCtes } from "./climbing-canonical-observations.ts";
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
const attemptDaySchema = workoutSchema.pick({ daysAgo: true }).extend({
  attempts: z.number().int().positive().nullable(),
});

export class ClimbingVolumeRepository extends BaseRepository {
  #comparisonRange(now: Date) {
    const endDate = formatDateYmdInTimeZone(now, this.timezone);
    const startDate = dateWindowStartString(endDate, climbingVolumeWindowDays - 1);
    if (
      this.accessWindow.kind === "limited" &&
      (this.accessWindow.startDate > startDate || this.accessWindow.endDateExclusive <= endDate)
    ) {
      return null;
    }
    return { startDate, endDate };
  }

  async getIncrease(now = new Date()): Promise<ClimbingVolumeIncrease> {
    const range = this.#comparisonRange(now);
    if (range === null) return { status: "insufficient_data" };
    const { startDate, endDate: today } = range;

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

  async getAttemptIncrease(now = new Date()): Promise<ClimbingAttemptIncrease> {
    const range = this.#comparisonRange(now);
    if (range === null) return { status: "insufficient_data" };

    const activityDay = postgresActivityCalendarDate(sql`activity_group`, this.timezone);
    const logs = canonicalClimbingLogCtes(range, {}, null, this.userId, this.timezone, (date) =>
      this.dateAccessPredicate(date),
    );
    const days = await this.query(
      attemptDaySchema,
      sql`WITH ${logs},
        attempts_per_day AS (
          SELECT session_date::date AS day, SUM(canonical_attempt_count)::int AS attempts
          FROM canonical_logs GROUP BY 1
        ), climbing_days AS (
          SELECT ${activityDay} AS day
          FROM fitness.v_activity_group AS activity_group
          WHERE activity_group.user_id = ${this.userId} AND activity_group.canonical_type = 'climbing'
            AND ${activityDay} BETWEEN ${range.startDate}::date AND ${range.endDate}::date
            AND activity_group.started_at <= ${now.toISOString()}::timestamptz
          UNION
          SELECT session_date::date AS day FROM dated_log_entries
          WHERE discipline = 'rock_climbing' AND provider_absent_at IS NULL
        )
        SELECT ${range.endDate}::date - climbing_days.day AS "daysAgo", attempts_per_day.attempts
        FROM climbing_days LEFT JOIN attempts_per_day USING (day)`,
    );
    return evaluateClimbingAttemptIncrease(days);
  }
}
