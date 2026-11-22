import { ropeMethodSchema } from "@dofek/training/climbing-log";
import type { ClimbingProjectHistory } from "@dofek/training/climbing-project-history";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { BaseRepository } from "../lib/base-repository.ts";
import { summarizeClimbingProjectHistory } from "../services/climbing-project-history.ts";

const historyRow = z.object({
  throughDate: z.iso.date().nullable(),
  date: z.iso.date().nullable(),
  outcome: z.enum(["send", "unsuccessful", "unknown"]),
  method: ropeMethodSchema.nullable(),
  selected: z.boolean(),
  repeat: z.boolean(),
  earlierAttempts: z.boolean(),
  described: z.boolean(),
});

const isBoard = sql`(entry.board IS NOT NULL OR entry.provider_id = 'boardsesh')`;
const boardSeshTimestamp = sql`CASE
  WHEN entry.raw ->> 'climbedAt' ~* '(Z|[+-][0-9]{2}:?[0-9]{2})$'
    THEN entry.raw ->> 'climbedAt'
  ELSE (entry.raw ->> 'climbedAt') || 'Z'
END`;

const activeLog = sql`entry.provider_absent_at IS NULL
  AND (entry.activity_id IS NULL OR attached.id IS NOT NULL)`;
const activeActivity = sql`LEFT JOIN fitness.activity AS attached
  ON attached.id = entry.activity_id AND attached.user_id = entry.user_id
    AND attached.deleted_at IS NULL AND attached.provider_absent_at IS NULL`;

export class ClimbingProjectHistoryRepository extends BaseRepository {
  async getProjectHistory(logEntryId: string): Promise<ClimbingProjectHistory | null | undefined> {
    // Only BoardSesh's imported climbedAt is a verified climb timestamp when climbed_on is absent.
    const calendarDay = sql`COALESCE(entry.climbed_on, CASE
      WHEN entry.provider_id = 'boardsesh'
        AND pg_input_is_valid((${boardSeshTimestamp}), 'timestamp with time zone')
      THEN ((${boardSeshTimestamp})::timestamptz AT TIME ZONE ${this.timezone})::date
    END)`;
    const rows = await this.query(
      historyRow,
      sql`
        WITH anchor AS (
          SELECT entry.id, entry.climb_id, entry.provider_id, entry.wall_angle,
            entry.raw ->> 'climbRevision' AS board_revision,
            entry.raw ->> 'layoutId' AS board_layout,
            calendar.day, ${isBoard} AS is_board,
            entry.discipline = 'rock_climbing' AND definition.kind IN ('boulder', 'route')
              AND definition.external_id IS NOT NULL
              AND (NOT ${isBoard} OR entry.wall_angle ? 'value') AS eligible
          FROM fitness.climbing_log_entry AS entry
          LEFT JOIN fitness.climb AS definition ON definition.id = entry.climb_id
          ${activeActivity}
          CROSS JOIN LATERAL (SELECT ${calendarDay} AS day) AS calendar
          WHERE entry.id = ${logEntryId}::uuid AND entry.user_id = ${this.userId}::uuid
            AND ${activeLog}
            ${this.dateAccessPredicate(sql`calendar.day`)}
        ), observations AS (
          SELECT calendar.day, attempt.rope_method AS method, entry.id = anchor.id AS selected,
            COALESCE(attempt.had_completed_before OR source_label.value = 'repeat', FALSE) AS repeat,
            COALESCE(source_label.value IN ('redpoint', 'ground-up redpoint', 'pinkpoint', 'rp'), FALSE)
              AS earlier_attempts,
            (source_label.value IS NOT NULL OR attempt.source_completed IS NOT NULL
              OR attempt.fell_or_hung IS NOT NULL OR attempt.used_aid IS NOT NULL
              OR attempt.dabbed IS NOT NULL) AS described,
            CASE
              WHEN attempt.source_completed IS FALSE OR attempt.fell_or_hung IS TRUE
                OR attempt.used_aid IS TRUE OR (definition.kind = 'boulder' AND attempt.dabbed IS TRUE)
                OR fitness.climbing_attempt_outcome(source_label.value) = 'failed'
                OR (entry.provider_id = 'thecrag' AND source_label.value IN ('working', 'retreat', 'ghost'))
                THEN 'unsuccessful'
              WHEN (entry.provider_id = 'boardsesh' AND attempt.source_completed IS TRUE
                  AND source_label.value IN ('flash', 'send'))
                OR ((attempt.source_completed IS TRUE OR
                    fitness.climbing_attempt_outcome(source_label.value) = 'completed')
                  AND attempt.used_aid IS FALSE AND attempt.fell_or_hung IS FALSE
                  AND (definition.kind = 'route' OR attempt.dabbed IS FALSE))
                THEN 'send'
              ELSE 'unknown'
            END AS outcome
          FROM anchor
          JOIN fitness.climbing_log_entry AS entry ON entry.climb_id = anchor.climb_id
            AND entry.user_id = ${this.userId}::uuid AND entry.provider_id = anchor.provider_id
          JOIN fitness.climb AS definition ON definition.id = entry.climb_id
          JOIN fitness.climbing_attempt AS attempt ON attempt.climbing_log_entry_id = entry.id
            AND attempt.scope = 'climb'
          ${activeActivity}
          CROSS JOIN LATERAL (SELECT ${calendarDay} AS day) AS calendar
          CROSS JOIN LATERAL (
            SELECT NULLIF(LOWER(BTRIM(COALESCE(attempt.source_result,
              CASE WHEN entry.provider_id = 'openbeta' THEN entry.raw ->> 'attemptType' END))), '') AS value
          ) AS source_label
          WHERE anchor.eligible AND ${activeLog} AND entry.discipline = 'rock_climbing'
            AND calendar.day <= anchor.day
            AND ${isBoard} = anchor.is_board
            AND (NOT anchor.is_board OR (
              entry.wall_angle = anchor.wall_angle
              AND (entry.raw ->> 'climbRevision') IS NOT DISTINCT FROM anchor.board_revision
              AND (entry.raw ->> 'layoutId') IS NOT DISTINCT FROM anchor.board_layout
            ))
            ${this.dateAccessPredicate(sql`calendar.day`)}
        )
        SELECT anchor.day::text AS "throughDate", observations.day::text AS date,
          COALESCE(observations.outcome, 'unknown') AS outcome, observations.method,
          COALESCE(observations.selected, FALSE) AS selected,
          COALESCE(observations.repeat, FALSE) AS repeat,
          COALESCE(observations.earlier_attempts, FALSE) AS "earlierAttempts",
          COALESCE(observations.described, FALSE) AS described
        FROM anchor LEFT JOIN observations ON TRUE
      `,
    );
    const anchor = rows[0];
    if (!anchor) return undefined;
    if (!anchor.throughDate) return null;
    const observations = rows.flatMap(({ date, throughDate: _throughDate, ...observation }) =>
      date ? [{ date, ...observation }] : [],
    );
    return observations.length
      ? summarizeClimbingProjectHistory(anchor.throughDate, observations)
      : null;
  }
}
