import {
  CLIMBING_GRADE_SYSTEMS,
  type ClimbingClimbType,
  type ClimbingGradePreference,
  type ClimbingGradeSystem,
  DEFAULT_CLIMBING_GRADE_PREFERENCE,
} from "@dofek/training/climbing-grades";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { ClimbingActivityEntryRow } from "../contracts/climbing-context-contracts.ts";
import { BaseRepository } from "../lib/base-repository.ts";
import { dateStringSchema, executeWithSchema } from "../lib/typed-sql.ts";
import { postgresActivityCalendarDate } from "./activity-local-date.ts";
import {
  type ClimbingActivityEntry,
  ClimbingActivityEntryRepository,
} from "./climbing-activity-entry-repository.ts";
import { displayClimbingGrade } from "./climbing-grade-display.ts";

export type { ClimbingActivityEntryRow, ClimbingClimbType, ClimbingGradeSystem };

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
  attempts: number | null;
  recordedAttempts: number | null;
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
  attempts: number | null;
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
const gradeSystemSchema = z.enum(CLIMBING_GRADE_SYSTEMS);
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
  attempts: z.coerce.number().nullable(),
  recorded_attempts: z.coerce.number().nullable(),
  sends: z.coerce.number(),
});
const sessionEntryRowSchema = z.object({
  activity_id: z.string(),
  session_date: dateStringSchema,
  name: z.string(),
  location_name: z.string().nullable(),
  attempt_count: z.coerce.number().nullable(),
  sent: z.boolean().nullable(),
  climb_type: climbTypeSchema,
  grade_system: gradeSystemSchema,
  grade: z.string(),
});
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
    const activityDate = postgresActivityCalendarDate(sql`a`, this.timezone);
    return sql`
      a.user_id = ${this.userId}
      AND a.canonical_type = 'climbing'
      AND (${activityDate}) > (NOW() AT TIME ZONE ${this.timezone})::date - ${days}::int
      AND (${activityDate}) <= (NOW() AT TIME ZONE ${this.timezone})::date
      ${this.dateAccessPredicate(activityDate)}
    `;
  }

  async getGradeProgression(days: number): Promise<ClimbingGradeProgression[]> {
    const rows = await executeWithSchema(
      this.db,
      progressionRowSchema,
      sql`WITH climbing_entries AS (
            SELECT
              (${postgresActivityCalendarDate(sql`a`, this.timezone)})::text AS session_date,
              ce.id, ce.activity_id, ce.climb_type, ce.grade_system, ce.grade,
              ce.sent, ce.attempt_count
            FROM fitness.v_activity AS a
            JOIN fitness.v_climbing_entry AS ce
              ON ce.activity_id = ANY(a.member_activity_ids)
             AND ce.provider_absent_at IS NULL
            WHERE ${this.#activityWindowPredicate(days)}
            UNION ALL
            SELECT
              ce.unattached_date::text AS session_date,
              ce.id, ce.activity_id, ce.climb_type, ce.grade_system, ce.grade,
              ce.sent, ce.attempt_count
            FROM fitness.v_climbing_entry AS ce
            WHERE ce.user_id = ${this.userId}
              AND ce.activity_id IS NULL
              AND ce.provider_absent_at IS NULL
              AND ce.unattached_date > (NOW() AT TIME ZONE ${this.timezone})::date - ${days}::int
              AND ce.unattached_date <= (NOW() AT TIME ZONE ${this.timezone})::date
              ${this.dateAccessPredicate(sql`ce.unattached_date`)}
          )
          SELECT
            ce.session_date,
            ce.climb_type,
            ce.grade_system,
            ce.grade
          FROM climbing_entries AS ce
          LEFT JOIN LATERAL (
            SELECT COUNT(*)::int AS attempt_count, BOOL_OR(attempt.outcome = 'sent') AS sent
            FROM fitness.climbing_attempt AS attempt
            WHERE attempt.climbing_entry_id = ce.id
          ) AS detail ON true
          WHERE CASE WHEN detail.attempt_count > 0 THEN detail.sent ELSE ce.sent END = true`,
    );
    const bestBySession = new Map<string, ClimbingGradeProgressionRow>();
    for (const row of rows) {
      const display = displayClimbingGrade(
        this.#gradePreference,
        row.climb_type,
        row.grade_system,
        row.grade,
      );
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
      sql`WITH climbing_entries AS (
            SELECT
              ce.id, ce.activity_id, ce.climb_type, ce.grade_system, ce.grade,
              ce.sent, ce.attempt_count
            FROM fitness.v_activity AS a
            JOIN fitness.v_climbing_entry AS ce
              ON ce.activity_id = ANY(a.member_activity_ids)
             AND ce.provider_absent_at IS NULL
            WHERE ${this.#activityWindowPredicate(days)}
            UNION ALL
            SELECT
              ce.id, ce.activity_id, ce.climb_type, ce.grade_system, ce.grade,
              ce.sent, ce.attempt_count
            FROM fitness.v_climbing_entry AS ce
            WHERE ce.user_id = ${this.userId}
              AND ce.activity_id IS NULL
              AND ce.provider_absent_at IS NULL
              AND ce.unattached_date > (NOW() AT TIME ZONE ${this.timezone})::date - ${days}::int
              AND ce.unattached_date <= (NOW() AT TIME ZONE ${this.timezone})::date
              ${this.dateAccessPredicate(sql`ce.unattached_date`)}
          )
          SELECT
            ce.climb_type,
            ce.grade_system,
            ce.grade,
            CASE WHEN COUNT(CASE WHEN detail.attempt_count > 0 THEN detail.attempt_count ELSE ce.attempt_count END) = COUNT(*)
              THEN SUM(CASE WHEN detail.attempt_count > 0 THEN detail.attempt_count ELSE ce.attempt_count END)
              ELSE NULL END AS attempts,
            SUM(CASE WHEN detail.attempt_count > 0 THEN detail.attempt_count ELSE ce.attempt_count END) AS recorded_attempts,
            COUNT(*) FILTER (WHERE CASE WHEN detail.attempt_count > 0 THEN detail.sent ELSE ce.sent END)::int AS sends
          FROM climbing_entries AS ce
          LEFT JOIN LATERAL (
            SELECT COUNT(*)::int AS attempt_count, BOOL_OR(attempt.outcome = 'sent') AS sent
            FROM fitness.climbing_attempt AS attempt
            WHERE attempt.climbing_entry_id = ce.id
          ) AS detail ON true
          GROUP BY ce.climb_type, ce.grade_system, ce.grade`,
    );
    const byDisplayGrade = new Map<string, ClimbingVolumeByGradeRow>();
    for (const row of rows) {
      const display = displayClimbingGrade(
        this.#gradePreference,
        row.climb_type,
        row.grade_system,
        row.grade,
      );
      if (!display) continue;
      const key = `${row.climb_type}:${display.gradeSystem}:${display.grade}`;
      const current = byDisplayGrade.get(key);
      if (current) {
        current.attempts =
          current.attempts === null || row.attempts === null
            ? null
            : current.attempts + row.attempts;
        current.recordedAttempts =
          current.recordedAttempts === null && row.recorded_attempts === null
            ? null
            : (current.recordedAttempts ?? 0) + (row.recorded_attempts ?? 0);
        current.sends += row.sends;
      } else {
        byDisplayGrade.set(key, {
          climbType: row.climb_type,
          ...display,
          attempts: row.attempts,
          recordedAttempts: row.recorded_attempts,
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
            (${postgresActivityCalendarDate(sql`a`, this.timezone)})::text AS session_date,
            COALESCE(a.name, 'Climbing') AS name,
            ce.location_name,
            CASE WHEN detail.attempt_count > 0 THEN detail.attempt_count ELSE ce.attempt_count END AS attempt_count,
            CASE WHEN detail.attempt_count > 0 THEN detail.sent ELSE ce.sent END AS sent,
            ce.climb_type,
            ce.grade_system,
            ce.grade
          FROM fitness.v_activity AS a
          JOIN fitness.v_climbing_entry AS ce
            ON ce.activity_id = ANY(a.member_activity_ids)
           AND ce.provider_absent_at IS NULL
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
      existing.attempts =
        existing.attempts === null || row.attempt_count === null
          ? null
          : existing.attempts + row.attempt_count;
      if (row.sent) existing.sends += 1;
      const display = row.sent
        ? displayClimbingGrade(this.#gradePreference, row.climb_type, row.grade_system, row.grade)
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

  getActivityEntries(activityId: string): Promise<ClimbingActivityEntry[]> {
    return new ClimbingActivityEntryRepository(
      this.db,
      this.userId,
      this.timezone,
      this.accessWindow,
      this.#gradePreference,
    ).getActivityEntries(activityId);
  }
}
