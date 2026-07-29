import { parseClimbingGrade } from "@dofek/training/climbing-grades";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { BaseRepository } from "../lib/base-repository.ts";
import { dateStringSchema, executeWithSchema } from "../lib/typed-sql.ts";

export type ClimbingClimbType = "boulder" | "route";
export type ClimbingGradeSystem = "v_scale" | "yds";

export interface ClimbingGradeProgressionRow {
  date: string;
  climbType: ClimbingClimbType;
  gradeSystem: ClimbingGradeSystem;
  grade: string;
  gradeSortValue: number;
}

export class ClimbingGradeProgression {
  readonly #row: ClimbingGradeProgressionRow;

  constructor(row: ClimbingGradeProgressionRow) {
    this.#row = row;
  }

  toDetail() {
    return {
      date: this.#row.date,
      climbType: this.#row.climbType,
      gradeSystem: this.#row.gradeSystem,
      grade: this.#row.grade,
      gradeSortValue: this.#row.gradeSortValue,
    };
  }
}

export interface ClimbingVolumeByGradeRow {
  climbType: ClimbingClimbType;
  gradeSystem: ClimbingGradeSystem;
  grade: string;
  gradeSortValue: number;
  attempts: number;
  sends: number;
}

export class ClimbingVolumeByGrade {
  readonly #row: ClimbingVolumeByGradeRow;

  constructor(row: ClimbingVolumeByGradeRow) {
    this.#row = row;
  }

  toDetail() {
    return {
      climbType: this.#row.climbType,
      gradeSystem: this.#row.gradeSystem,
      grade: this.#row.grade,
      gradeSortValue: this.#row.gradeSortValue,
      attempts: this.#row.attempts,
      sends: this.#row.sends,
    };
  }
}

export interface ClimbingSessionSummaryRow {
  activityId: string;
  date: string;
  name: string;
  locationName: string | null;
  attempts: number;
  sends: number;
  hardestBoulderGrade: string | null;
  hardestBoulderGradeSortValue: number | null;
  hardestRouteGrade: string | null;
  hardestRouteGradeSortValue: number | null;
}

export class ClimbingSessionSummary {
  readonly #row: ClimbingSessionSummaryRow;

  constructor(row: ClimbingSessionSummaryRow) {
    this.#row = row;
  }

  toDetail() {
    return {
      activityId: this.#row.activityId,
      date: this.#row.date,
      name: this.#row.name,
      locationName: this.#row.locationName,
      attempts: this.#row.attempts,
      sends: this.#row.sends,
      hardestBoulderGrade: this.#row.hardestBoulderGrade,
      hardestBoulderGradeSortValue: this.#row.hardestBoulderGradeSortValue,
      hardestRouteGrade: this.#row.hardestRouteGrade,
      hardestRouteGradeSortValue: this.#row.hardestRouteGradeSortValue,
    };
  }
}

const climbTypeSchema = z.enum(["boulder", "route"]);
const gradeSystemSchema = z.enum(["v_scale", "yds"]);
const ascentTypeSchema = z.enum(["Flash", "Onsight", "Redpoint", "Repeat"]);
const attemptOutcomeSchema = z.enum(["sent", "failed"]);
const failureReasonSchema = z.enum(["fell", "pumped", "skin", "technique", "fear"]);
const holdTypeSchema = z.enum(["crimp", "sloper", "pinch", "pocket", "jug"]);
const climbingAttemptDetailSchema = z.object({
  attemptIndex: z.coerce.number().int().positive(),
  failureReason: failureReasonSchema.nullable(),
  notes: z.string().nullable(),
  outcome: attemptOutcomeSchema,
});

const activityEntryRowSchema = z.object({
  id: z.string(),
  climb_type: climbTypeSchema,
  grade_system: gradeSystemSchema,
  grade: z.string(),
  sent: z.boolean(),
  attempt_count: z.coerce.number().int().positive(),
  attempts: z.array(climbingAttemptDetailSchema),
  ascent_type: ascentTypeSchema.nullable(),
  hold_type: holdTypeSchema.nullable(),
  route_name: z.string().nullable(),
  location_name: z.string().nullable(),
  source_name: z.string(),
  wall_angle_degrees: z.coerce.number().nullable(),
});
type ClimbingActivityEntryDatabaseRow = z.infer<typeof activityEntryRowSchema>;

export interface ClimbingActivityEntryRow {
  id: string;
  climbType: ClimbingClimbType;
  gradeSystem: ClimbingGradeSystem;
  grade: string;
  sent: boolean;
  attemptCount: number;
  attempts: Array<z.infer<typeof climbingAttemptDetailSchema>>;
  ascentType: ClimbingActivityEntryDatabaseRow["ascent_type"];
  holdType: z.infer<typeof holdTypeSchema> | null;
  routeName: string | null;
  locationName: string | null;
  sourceName: string;
  wallAngleDegrees: number | null;
}

export class ClimbingActivityEntry {
  readonly #row: ClimbingActivityEntryRow;

  constructor(row: ClimbingActivityEntryRow) {
    this.#row = row;
  }

  toDetail(): ClimbingActivityEntryRow {
    return this.#row;
  }
}

const progressionRowSchema = z.object({
  session_date: dateStringSchema,
  climb_type: climbTypeSchema,
  grade_system: gradeSystemSchema,
  grade: z.string(),
  grade_sort_value: z.coerce.number(),
});

const volumeByGradeRowSchema = z.object({
  climb_type: climbTypeSchema,
  grade_system: gradeSystemSchema,
  grade: z.string(),
  grade_sort_value: z.coerce.number(),
  attempts: z.coerce.number(),
  sends: z.coerce.number(),
});

const sessionSummaryRowSchema = z.object({
  activity_id: z.string(),
  session_date: dateStringSchema,
  name: z.string(),
  location_name: z.string().nullable(),
  attempts: z.coerce.number(),
  sends: z.coerce.number(),
  hardest_boulder_grade: z.string().nullable(),
  hardest_boulder_grade_sort_value: z.coerce.number().nullable(),
  hardest_route_grade: z.string().nullable(),
  hardest_route_grade_sort_value: z.coerce.number().nullable(),
});

const climbingGradeSortSql = sql`
  CASE
    WHEN ce.grade_system = 'v_scale' AND ce.grade = 'VB' THEN -1
    WHEN ce.grade_system = 'v_scale' AND ce.grade ~ '^V[0-9]+$' THEN substring(ce.grade from 2)::int
    WHEN ce.grade_system = 'yds' AND ce.grade ~ '^5\\.[0-9]+[abcd]$' THEN
      5000
      + (substring(ce.grade from '^5\\.([0-9]+)')::int * 10)
      + CASE right(ce.grade, 1)
          WHEN 'a' THEN 1
          WHEN 'b' THEN 2
          WHEN 'c' THEN 3
          WHEN 'd' THEN 4
        END
    WHEN ce.grade_system = 'yds' AND ce.grade ~ '^5\\.[0-9]+-$' THEN
      5000 + (substring(ce.grade from '^5\\.([0-9]+)')::int * 10) - 3
    WHEN ce.grade_system = 'yds' AND ce.grade ~ '^5\\.[0-9]+\\+$' THEN
      5000 + (substring(ce.grade from '^5\\.([0-9]+)')::int * 10) + 5
    WHEN ce.grade_system = 'yds' AND ce.grade ~ '^5\\.[0-9]+$' THEN
      5000 + (substring(ce.grade from '^5\\.([0-9]+)')::int * 10)
    ELSE NULL
  END
`;

export class ClimbingRepository extends BaseRepository {
  #activityWindowPredicate(days: number) {
    return sql`
      a.user_id = ${this.userId}
      AND a.canonical_type = 'climbing'
      AND a.started_at > NOW() - ${days}::int * INTERVAL '1 day'
      ${this.timestampAccessPredicate(sql`a.started_at`)}
    `;
  }

  async getGradeProgression(days: number): Promise<ClimbingGradeProgression[]> {
    const rows = await executeWithSchema(
      this.db,
      progressionRowSchema,
      sql`WITH ranked_sent AS (
            SELECT
              (a.started_at AT TIME ZONE ${this.timezone})::date::text AS session_date,
              ce.climb_type,
              ce.grade_system,
              ce.grade,
              ${climbingGradeSortSql} AS grade_sort_value,
              ROW_NUMBER() OVER (
                PARTITION BY (a.started_at AT TIME ZONE ${this.timezone})::date, ce.climb_type
                ORDER BY ${climbingGradeSortSql} DESC NULLS LAST
              ) AS grade_rank
            FROM fitness.v_activity a
            JOIN fitness.climbing_entry ce ON ce.activity_id = ANY(a.member_activity_ids)
            LEFT JOIN LATERAL (
              SELECT
                COUNT(*)::int AS attempt_count,
                BOOL_OR(attempt.outcome = 'sent') AS sent
              FROM fitness.climbing_attempt AS attempt
              WHERE attempt.climbing_entry_id = ce.id
            ) AS detail ON true
            WHERE ${this.#activityWindowPredicate(days)}
              AND CASE
                WHEN detail.attempt_count > 0 THEN detail.sent
                ELSE ce.sent
              END = true
              AND ${climbingGradeSortSql} IS NOT NULL
          )
          SELECT session_date, climb_type, grade_system, grade, grade_sort_value
          FROM ranked_sent
          WHERE grade_rank = 1
          ORDER BY session_date, climb_type`,
    );

    return rows.map(
      (row) =>
        new ClimbingGradeProgression({
          date: row.session_date,
          climbType: row.climb_type,
          gradeSystem: row.grade_system,
          grade: normalizedGrade(row.grade),
          gradeSortValue: row.grade_sort_value,
        }),
    );
  }

  async getVolumeByGrade(days: number): Promise<ClimbingVolumeByGrade[]> {
    const rows = await executeWithSchema(
      this.db,
      volumeByGradeRowSchema,
      sql`SELECT
            ce.climb_type,
            ce.grade_system,
            ce.grade,
            ${climbingGradeSortSql} AS grade_sort_value,
            SUM(
              CASE
                WHEN detail.attempt_count > 0 THEN detail.attempt_count
                ELSE ce.attempt_count
              END
            ) AS attempts,
            COUNT(*) FILTER (
              WHERE CASE
                WHEN detail.attempt_count > 0 THEN detail.sent
                ELSE ce.sent
              END
            )::int AS sends
          FROM fitness.v_activity a
          JOIN fitness.climbing_entry ce ON ce.activity_id = ANY(a.member_activity_ids)
          LEFT JOIN LATERAL (
            SELECT
              COUNT(*)::int AS attempt_count,
              BOOL_OR(attempt.outcome = 'sent') AS sent
            FROM fitness.climbing_attempt AS attempt
            WHERE attempt.climbing_entry_id = ce.id
          ) AS detail ON true
          WHERE ${this.#activityWindowPredicate(days)}
            AND ${climbingGradeSortSql} IS NOT NULL
          GROUP BY ce.climb_type, ce.grade_system, ce.grade, grade_sort_value
          ORDER BY grade_sort_value`,
    );

    return rows.map(
      (row) =>
        new ClimbingVolumeByGrade({
          climbType: row.climb_type,
          gradeSystem: row.grade_system,
          grade: normalizedGrade(row.grade),
          gradeSortValue: row.grade_sort_value,
          attempts: row.attempts,
          sends: row.sends,
        }),
    );
  }

  async getSessionSummaries(days: number): Promise<ClimbingSessionSummary[]> {
    const rows = await executeWithSchema(
      this.db,
      sessionSummaryRowSchema,
      sql`WITH climbing_entries AS (
            SELECT
              a.id AS activity_id,
              (a.started_at AT TIME ZONE ${this.timezone})::date::text AS session_date,
              COALESCE(a.name, 'Climbing') AS name,
              ce.location_name,
              CASE
                WHEN detail.attempt_count > 0 THEN detail.attempt_count
                ELSE ce.attempt_count
              END AS attempt_count,
              CASE
                WHEN detail.attempt_count > 0 THEN detail.sent
                ELSE ce.sent
              END AS sent,
              ce.climb_type,
              ce.grade,
              ${climbingGradeSortSql} AS grade_sort_value
            FROM fitness.v_activity a
            JOIN fitness.climbing_entry ce ON ce.activity_id = ANY(a.member_activity_ids)
            LEFT JOIN LATERAL (
              SELECT
                COUNT(*)::int AS attempt_count,
                BOOL_OR(attempt.outcome = 'sent') AS sent
              FROM fitness.climbing_attempt AS attempt
              WHERE attempt.climbing_entry_id = ce.id
            ) AS detail ON true
            WHERE ${this.#activityWindowPredicate(days)}
              AND ${climbingGradeSortSql} IS NOT NULL
          )
          SELECT
            activity_id,
            session_date,
            name,
            MAX(location_name) FILTER (WHERE location_name IS NOT NULL) AS location_name,
            SUM(attempt_count) AS attempts,
            COUNT(*) FILTER (WHERE sent)::int AS sends,
            (ARRAY_AGG(grade ORDER BY grade_sort_value DESC NULLS LAST)
              FILTER (WHERE sent AND climb_type = 'boulder'))[1] AS hardest_boulder_grade,
            (ARRAY_AGG(grade_sort_value ORDER BY grade_sort_value DESC NULLS LAST)
              FILTER (WHERE sent AND climb_type = 'boulder'))[1] AS hardest_boulder_grade_sort_value,
            (ARRAY_AGG(grade ORDER BY grade_sort_value DESC NULLS LAST)
              FILTER (WHERE sent AND climb_type = 'route'))[1] AS hardest_route_grade,
            (ARRAY_AGG(grade_sort_value ORDER BY grade_sort_value DESC NULLS LAST)
              FILTER (WHERE sent AND climb_type = 'route'))[1] AS hardest_route_grade_sort_value
          FROM climbing_entries
          GROUP BY activity_id, session_date, name
          ORDER BY session_date DESC`,
    );

    return rows.map(
      (row) =>
        new ClimbingSessionSummary({
          activityId: row.activity_id,
          date: row.session_date,
          name: row.name,
          locationName: row.location_name,
          attempts: row.attempts,
          sends: row.sends,
          hardestBoulderGrade: nullableNormalizedGrade(row.hardest_boulder_grade),
          hardestBoulderGradeSortValue: row.hardest_boulder_grade_sort_value,
          hardestRouteGrade: nullableNormalizedGrade(row.hardest_route_grade),
          hardestRouteGradeSortValue: row.hardest_route_grade_sort_value,
        }),
    );
  }

  async getActivityEntries(activityId: string): Promise<ClimbingActivityEntry[]> {
    const rows = await executeWithSchema(
      this.db,
      activityEntryRowSchema,
      sql`SELECT
            ce.id::text AS id,
            ce.climb_type,
            ce.grade_system,
            ce.grade,
            CASE
              WHEN detail.attempt_count > 0 THEN detail.sent
              ELSE ce.sent
            END AS sent,
            CASE
              WHEN detail.attempt_count > 0 THEN detail.attempt_count
              ELSE ce.attempt_count
            END AS attempt_count,
            COALESCE(detail.attempts, '[]'::jsonb) AS attempts,
            ce.raw->>'ascentType' AS ascent_type,
            ce.hold_type,
            ce.route_name,
            ce.location_name,
            ce.source_name,
            ce.wall_angle_degrees
          FROM fitness.v_activity a
          JOIN fitness.climbing_entry ce ON ce.activity_id = ANY(a.member_activity_ids)
          LEFT JOIN LATERAL (
            SELECT
              COUNT(*)::int AS attempt_count,
              BOOL_OR(attempt.outcome = 'sent') AS sent,
              jsonb_agg(
                jsonb_build_object(
                  'attemptIndex', attempt.attempt_index,
                  'failureReason', attempt.failure_reason,
                  'notes', attempt.notes,
                  'outcome', attempt.outcome
                )
                ORDER BY attempt.attempt_index
              ) AS attempts
            FROM fitness.climbing_attempt AS attempt
            WHERE attempt.climbing_entry_id = ce.id
          ) AS detail ON true
          WHERE a.user_id = ${this.userId}::uuid
            AND ${activityId}::uuid = ANY(a.member_activity_ids)
            ${this.timestampAccessPredicate(sql`a.started_at`)}
          ORDER BY ${climbingGradeSortSql} NULLS LAST, ce.route_name NULLS LAST, ce.id`,
    );

    return rows.map(
      (row) =>
        new ClimbingActivityEntry({
          id: row.id,
          climbType: row.climb_type,
          gradeSystem: row.grade_system,
          grade: normalizedGrade(row.grade),
          sent: row.sent,
          attemptCount: row.attempt_count,
          attempts: row.attempts,
          ascentType: row.ascent_type,
          holdType: row.hold_type,
          routeName: row.route_name,
          locationName: row.location_name,
          sourceName: row.source_name,
          wallAngleDegrees: row.wall_angle_degrees,
        }),
    );
  }
}

function normalizedGrade(grade: string): string {
  const parsedGrade = parseClimbingGrade(grade);
  if (!parsedGrade) {
    throw new Error(`Unsupported climbing grade: ${grade}`);
  }

  return parsedGrade.grade;
}

function nullableNormalizedGrade(grade: string | null): string | null {
  return grade === null ? null : normalizedGrade(grade);
}
