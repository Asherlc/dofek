import { isValidClimbingGrade } from "@dofek/training/climbing-grades";
import { climbSettingSchema } from "@dofek/training/climbing-log";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { BaseRepository } from "../lib/base-repository.ts";
import {
  postgresActivityCalendarDate,
  postgresActivityDateIsAuthoritative,
} from "./activity-local-date.ts";

const observationSchema = z.object({
  provider_id: z.string(),
  climb_external_id: z.string(),
  board_external_id: z.string().nullable(),
  board_angle: z.number().nullable(),
  date: z.iso.date(),
  setting: climbSettingSchema,
  style: z.enum(["bouldering", "sport_lead", "trad_lead"]),
  grade_system: z.enum(["v_scale", "ewbank", "french", "uiaa"]),
  grade: z.string(),
  grade_provenance: z.literal("current_assigned"),
  sent: z.boolean(),
  source_log_ids: z.array(z.uuid()),
});

/** Dated, explicit whole-climb outcomes for offline forecast evaluation. */
export class ClimbingForecastRepository extends BaseRepository {
  async listClimbDays(range: { startDate: string; endDate: string }) {
    const activityAlias = sql`recorded_activity`;
    const date = sql`COALESCE(entry.climbed_on, CASE
      WHEN ${postgresActivityDateIsAuthoritative(activityAlias)}
        AND ${activityAlias}.provider_id = entry.provider_id
      THEN ${postgresActivityCalendarDate(activityAlias, this.timezone)} END)`;
    const rows = await this.query(
      observationSchema,
      sql`
        WITH attempts AS (
          SELECT entry.id AS log_id, entry.provider_id, target.external_id AS climb_external_id,
            ${date} AS date, target.setting,
            entry.board ->> 'externalId' AS board_external_id,
            CASE WHEN entry.board IS NOT NULL AND entry.wall_angle ->> 'unit' = 'degrees'
              THEN (entry.wall_angle ->> 'value')::double precision END AS board_angle,
            assigned.system AS grade_system, assigned.value AS grade,
            CASE
              WHEN target.kind = 'boulder' THEN 'bouldering'
              WHEN attempt.rope_method = 'lead' AND attempt.protection_used = ARRAY['sport']::fitness.protection_style[]
                THEN 'sport_lead'
              WHEN attempt.rope_method = 'lead' AND attempt.protection_used = ARRAY['trad']::fitness.protection_style[]
                THEN 'trad_lead'
            END AS style,
            CASE
              WHEN recorded.outcome = 'failed'
                OR attempt.fell_or_hung = TRUE OR (target.kind = 'boulder' AND attempt.dabbed = TRUE)
                THEN FALSE
              WHEN recorded.outcome = 'completed'
                AND attempt.used_aid = FALSE AND attempt.fell_or_hung = FALSE
                AND (target.kind = 'route' OR attempt.dabbed = FALSE) THEN TRUE
            END AS sent
          FROM fitness.climbing_log_entry AS entry
          JOIN fitness.climb AS target ON target.id = entry.climb_id
            AND target.user_id = entry.user_id AND target.provider_id = entry.provider_id
          LEFT JOIN fitness.activity AS recorded_activity ON recorded_activity.id = entry.activity_id
            AND recorded_activity.user_id = entry.user_id
          JOIN fitness.climbing_attempt AS attempt ON attempt.climbing_log_entry_id = entry.id
          CROSS JOIN LATERAL (
            SELECT CASE
              WHEN attempt.source_completed = TRUE THEN 'completed'
              WHEN attempt.source_completed = FALSE THEN 'failed'
              ELSE fitness.climbing_attempt_outcome(attempt.source_result)
            END AS outcome
          ) AS recorded
          JOIN LATERAL (
            SELECT grade.system, MIN(grade.value) AS value
            FROM fitness.climb_grade AS grade WHERE grade.climb_id = target.id
              AND ((target.kind = 'boulder' AND grade.system = 'v_scale')
                OR (target.kind = 'route' AND grade.system IN ('ewbank', 'french', 'uiaa')))
            GROUP BY grade.system HAVING COUNT(DISTINCT grade.value) = 1
          ) AS assigned ON TRUE
          WHERE entry.user_id = ${this.userId} AND entry.provider_absent_at IS NULL
            AND (entry.activity_id IS NULL OR (recorded_activity.id IS NOT NULL
              AND recorded_activity.deleted_at IS NULL AND recorded_activity.provider_absent_at IS NULL))
            AND entry.discipline = 'rock_climbing' AND target.setting IS NOT NULL
            AND NULLIF(BTRIM(target.external_id), '') IS NOT NULL
            AND attempt.scope = 'climb' AND attempt.solo IS DISTINCT FROM TRUE
            AND attempt.used_aid IS DISTINCT FROM TRUE
            AND (entry.board IS NULL OR (NULLIF(BTRIM(entry.board ->> 'externalId'), '') IS NOT NULL
              AND entry.wall_angle ->> 'unit' = 'degrees'
              AND jsonb_typeof(entry.wall_angle -> 'value') = 'number'))
            AND ${date} BETWEEN ${range.startDate}::date AND ${range.endDate}::date
            ${this.dateAccessPredicate(date)}
        )
        SELECT provider_id, climb_external_id, board_external_id, board_angle, date::text, setting,
          style, grade_system, grade, 'current_assigned' AS grade_provenance,
          BOOL_OR(sent IS TRUE) AS sent, ARRAY_AGG(DISTINCT log_id ORDER BY log_id) AS source_log_ids
        FROM attempts WHERE style IS NOT NULL
        GROUP BY provider_id, climb_external_id, board_external_id, board_angle, date, setting,
          style, grade_system, grade
        HAVING BOOL_OR(sent IS TRUE) OR BOOL_AND(sent IS FALSE)
        ORDER BY date, provider_id, climb_external_id, setting, style, grade_system,
          board_external_id, board_angle
      `,
    );
    // Shared catalogue grades are current snapshots. The export makes no historical as-of claim.
    return rows.filter((row) => isValidClimbingGrade(row.grade, row.grade_system));
  }
}
