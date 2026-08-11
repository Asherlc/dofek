import {
  type ClimbingClimbType,
  type ClimbingGradePreference,
  type ClimbingGradeSystem,
  convertClimbingGrade,
  DEFAULT_CLIMBING_GRADE_PREFERENCE,
  gradeSortValue,
  isGradeSystemForClimbType,
} from "@dofek/training/climbing-grades";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { BaseRepository } from "../lib/base-repository.ts";
import { dateStringSchema, executeWithSchema } from "../lib/typed-sql.ts";

export type { ClimbingClimbType, ClimbingGradeSystem };

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

  toDetail(): ClimbingGradeProgressionRow {
    return this.#row;
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

  toDetail(): ClimbingVolumeByGradeRow {
    return this.#row;
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

  toDetail(): ClimbingSessionSummaryRow {
    return this.#row;
  }
}

const climbTypeSchema = z.enum(["boulder", "route"]);
const gradeSystemSchema = z.enum([
  "v_scale",
  "font",
  "yds",
  "french",
  "uiaa",
  "ewbank",
  "saxon",
  "norwegian",
  "brazilian_crux",
]);
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

const progressionRowSchema = z.object({
  session_date: dateStringSchema,
  climb_type: climbTypeSchema,
  grade_system: gradeSystemSchema,
  grade: z.string(),
});
const volumeByGradeRowSchema = z.object({
  climb_type: climbTypeSchema,
  grade_system: gradeSystemSchema,
  grade: z.string(),
  attempts: z.coerce.number(),
  sends: z.coerce.number(),
});
const sessionEntryRowSchema = z.object({
  activity_id: z.string(),
  session_date: dateStringSchema,
  name: z.string(),
  location_name: z.string().nullable(),
  attempt_count: z.coerce.number(),
  sent: z.boolean(),
  climb_type: climbTypeSchema,
  grade_system: gradeSystemSchema,
  grade: z.string(),
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

interface DisplayGrade {
  grade: string;
  gradeSortValue: number;
  gradeSystem: ClimbingGradeSystem;
}

export class ClimbingRepository extends BaseRepository {
  readonly #gradePreference: ClimbingGradePreference;

  constructor(
    db: ConstructorParameters<typeof BaseRepository>[0],
    userId: string,
    timezone: string,
    accessWindow?: ConstructorParameters<typeof BaseRepository>[3],
    gradePreference: ClimbingGradePreference = DEFAULT_CLIMBING_GRADE_PREFERENCE,
  ) {
    super(db, userId, timezone, accessWindow);
    this.#gradePreference = gradePreference;
  }

  #activityWindowPredicate(days: number) {
    return sql`
      a.user_id = ${this.userId}
      AND a.canonical_type = 'climbing'
      AND a.started_at > NOW() - ${days}::int * INTERVAL '1 day'
      ${this.timestampAccessPredicate(sql`a.started_at`)}
    `;
  }

  #displayGrade(
    climbType: ClimbingClimbType,
    sourceSystem: ClimbingGradeSystem,
    sourceGrade: string,
  ): DisplayGrade | null {
    if (!isGradeSystemForClimbType(sourceSystem, climbType)) return null;
    const displaySystem = this.#gradePreference[climbType];
    const converted = convertClimbingGrade({
      grade: sourceGrade,
      sourceSystem,
      displaySystem,
    });
    if (converted) {
      return {
        grade: converted.displayGrade,
        gradeSystem: converted.displaySystem,
        gradeSortValue: converted.sortValue,
      };
    }
    const sourceSortValue = gradeSortValue(sourceGrade, sourceSystem);
    return sourceSortValue === null
      ? null
      : { grade: sourceGrade, gradeSystem: sourceSystem, gradeSortValue: sourceSortValue };
  }

  async getGradeProgression(days: number): Promise<ClimbingGradeProgression[]> {
    const rows = await executeWithSchema(
      this.db,
      progressionRowSchema,
      sql`SELECT
            (a.started_at AT TIME ZONE ${this.timezone})::date::text AS session_date,
            ce.climb_type,
            ce.grade_system,
            ce.grade
          FROM fitness.v_activity AS a
          JOIN fitness.climbing_entry AS ce ON ce.activity_id = ANY(a.member_activity_ids)
          LEFT JOIN LATERAL (
            SELECT COUNT(*)::int AS attempt_count, BOOL_OR(attempt.outcome = 'sent') AS sent
            FROM fitness.climbing_attempt AS attempt
            WHERE attempt.climbing_entry_id = ce.id
          ) AS detail ON true
          WHERE ${this.#activityWindowPredicate(days)}
            AND CASE WHEN detail.attempt_count > 0 THEN detail.sent ELSE ce.sent END = true`,
    );
    const bestBySession = new Map<string, ClimbingGradeProgressionRow>();
    for (const row of rows) {
      const display = this.#displayGrade(row.climb_type, row.grade_system, row.grade);
      if (!display) continue;
      const key = `${row.session_date}:${row.climb_type}`;
      const candidate = { date: row.session_date, climbType: row.climb_type, ...display };
      const current = bestBySession.get(key);
      if (!current || candidate.gradeSortValue > current.gradeSortValue)
        bestBySession.set(key, candidate);
    }
    return [...bestBySession.values()]
      .sort(
        (left, right) =>
          left.date.localeCompare(right.date) || left.climbType.localeCompare(right.climbType),
      )
      .map((row) => new ClimbingGradeProgression(row));
  }

  async getVolumeByGrade(days: number): Promise<ClimbingVolumeByGrade[]> {
    const rows = await executeWithSchema(
      this.db,
      volumeByGradeRowSchema,
      sql`SELECT
            ce.climb_type,
            ce.grade_system,
            ce.grade,
            SUM(CASE WHEN detail.attempt_count > 0 THEN detail.attempt_count ELSE ce.attempt_count END) AS attempts,
            COUNT(*) FILTER (WHERE CASE WHEN detail.attempt_count > 0 THEN detail.sent ELSE ce.sent END)::int AS sends
          FROM fitness.v_activity AS a
          JOIN fitness.climbing_entry AS ce ON ce.activity_id = ANY(a.member_activity_ids)
          LEFT JOIN LATERAL (
            SELECT COUNT(*)::int AS attempt_count, BOOL_OR(attempt.outcome = 'sent') AS sent
            FROM fitness.climbing_attempt AS attempt
            WHERE attempt.climbing_entry_id = ce.id
          ) AS detail ON true
          WHERE ${this.#activityWindowPredicate(days)}
          GROUP BY ce.climb_type, ce.grade_system, ce.grade`,
    );
    const byDisplayGrade = new Map<string, ClimbingVolumeByGradeRow>();
    for (const row of rows) {
      const display = this.#displayGrade(row.climb_type, row.grade_system, row.grade);
      if (!display) continue;
      const key = `${row.climb_type}:${display.gradeSystem}:${display.grade}`;
      const current = byDisplayGrade.get(key);
      if (current) {
        current.attempts += row.attempts;
        current.sends += row.sends;
      } else {
        byDisplayGrade.set(key, {
          climbType: row.climb_type,
          ...display,
          attempts: row.attempts,
          sends: row.sends,
        });
      }
    }
    return [...byDisplayGrade.values()]
      .sort((left, right) => left.gradeSortValue - right.gradeSortValue)
      .map((row) => new ClimbingVolumeByGrade(row));
  }

  async getSessionSummaries(days: number): Promise<ClimbingSessionSummary[]> {
    const rows = await executeWithSchema(
      this.db,
      sessionEntryRowSchema,
      sql`SELECT
            a.id::text AS activity_id,
            (a.started_at AT TIME ZONE ${this.timezone})::date::text AS session_date,
            COALESCE(a.name, 'Climbing') AS name,
            ce.location_name,
            CASE WHEN detail.attempt_count > 0 THEN detail.attempt_count ELSE ce.attempt_count END AS attempt_count,
            CASE WHEN detail.attempt_count > 0 THEN detail.sent ELSE ce.sent END AS sent,
            ce.climb_type,
            ce.grade_system,
            ce.grade
          FROM fitness.v_activity AS a
          JOIN fitness.climbing_entry AS ce ON ce.activity_id = ANY(a.member_activity_ids)
          LEFT JOIN LATERAL (
            SELECT COUNT(*)::int AS attempt_count, BOOL_OR(attempt.outcome = 'sent') AS sent
            FROM fitness.climbing_attempt AS attempt
            WHERE attempt.climbing_entry_id = ce.id
          ) AS detail ON true
          WHERE ${this.#activityWindowPredicate(days)}`,
    );
    const summaries = new Map<string, ClimbingSessionSummaryRow>();
    for (const row of rows) {
      const existing = summaries.get(row.activity_id) ?? {
        activityId: row.activity_id,
        date: row.session_date,
        name: row.name,
        locationName: row.location_name,
        attempts: 0,
        sends: 0,
        hardestBoulderGrade: null,
        hardestBoulderGradeSortValue: null,
        hardestRouteGrade: null,
        hardestRouteGradeSortValue: null,
      };
      if (existing.locationName === null && row.location_name !== null) {
        existing.locationName = row.location_name;
      }
      existing.attempts += row.attempt_count;
      if (row.sent) existing.sends += 1;
      const display = row.sent
        ? this.#displayGrade(row.climb_type, row.grade_system, row.grade)
        : null;
      if (
        display &&
        row.climb_type === "boulder" &&
        (existing.hardestBoulderGradeSortValue === null ||
          display.gradeSortValue > existing.hardestBoulderGradeSortValue)
      ) {
        existing.hardestBoulderGrade = display.grade;
        existing.hardestBoulderGradeSortValue = display.gradeSortValue;
      }
      if (
        display &&
        row.climb_type === "route" &&
        (existing.hardestRouteGradeSortValue === null ||
          display.gradeSortValue > existing.hardestRouteGradeSortValue)
      ) {
        existing.hardestRouteGrade = display.grade;
        existing.hardestRouteGradeSortValue = display.gradeSortValue;
      }
      summaries.set(row.activity_id, existing);
    }
    return [...summaries.values()]
      .sort((left, right) => right.date.localeCompare(left.date))
      .map((row) => new ClimbingSessionSummary(row));
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
            CASE WHEN detail.attempt_count > 0 THEN detail.sent ELSE ce.sent END AS sent,
            CASE WHEN detail.attempt_count > 0 THEN detail.attempt_count ELSE ce.attempt_count END AS attempt_count,
            COALESCE(detail.attempts, '[]'::jsonb) AS attempts,
            ce.raw->>'ascentType' AS ascent_type,
            ce.hold_type,
            ce.route_name,
            ce.location_name,
            ce.source_name,
            ce.wall_angle_degrees
          FROM fitness.v_activity AS a
          JOIN fitness.climbing_entry AS ce ON ce.activity_id = ANY(a.member_activity_ids)
          LEFT JOIN LATERAL (
            SELECT
              COUNT(*)::int AS attempt_count,
              BOOL_OR(attempt.outcome = 'sent') AS sent,
              jsonb_agg(jsonb_build_object(
                'attemptIndex', attempt.attempt_index,
                'failureReason', attempt.failure_reason,
                'notes', attempt.notes,
                'outcome', attempt.outcome
              ) ORDER BY attempt.attempt_index) AS attempts
            FROM fitness.climbing_attempt AS attempt
            WHERE attempt.climbing_entry_id = ce.id
          ) AS detail ON true
          WHERE a.user_id = ${this.userId}::uuid
            AND ${activityId}::uuid = ANY(a.member_activity_ids)
            ${this.timestampAccessPredicate(sql`a.started_at`)}`,
    );
    return rows
      .map((row) => {
        const display = this.#displayGrade(row.climb_type, row.grade_system, row.grade);
        return display
          ? { row, display }
          : {
              row,
              display: {
                grade: row.grade,
                gradeSystem: row.grade_system,
                gradeSortValue: -1e9,
              },
            };
      })
      .sort((left, right) => right.display.gradeSortValue - left.display.gradeSortValue)
      .map(
        ({ row, display }) =>
          new ClimbingActivityEntry({
            id: row.id,
            climbType: row.climb_type,
            gradeSystem: display.gradeSystem,
            grade: display.grade,
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
