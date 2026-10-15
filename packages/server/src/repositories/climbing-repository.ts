import type { ClimbingFilters } from "@dofek/training/climbing-filters";
import {
  type ClimbingGradePreference,
  DEFAULT_CLIMBING_GRADE_PREFERENCE,
  FREE_ROCK_GRADE_SYSTEMS,
  type FreeRockGradeSystem,
  type RockClimbKind,
} from "@dofek/training/climbing-grades";
import { attemptScopeSchema, ropeMethodSchema } from "@dofek/training/climbing-log";
import {
  type ClimbingGradeProgressionLane,
  climbingGradeProgressionSchema,
  climbingProgressionSettings,
} from "@dofek/training/climbing-progression";
import { type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import type { ClimbingLogEntryDetail } from "../contracts/climbing-log-contracts.ts";
import { BaseRepository } from "../lib/base-repository.ts";
import { dateStringSchema, executeWithSchema } from "../lib/typed-sql.ts";
import { postgresActivityCalendarDate } from "./activity-local-date.ts";
import {
  type ClimbingActivityLogEntry,
  ClimbingActivityLogEntryRepository,
} from "./climbing-activity-log-entry-repository.ts";
import { displayClimbingGrade } from "./climbing-grade-display.ts";
import {
  buildClimbingGradeProgression,
  type ClimbingProgressionEntry,
} from "./climbing-grade-progression.ts";
import { rockClimbingLogProjection } from "./climbing-rock-observations.ts";

export type { ClimbingLogEntryDetail, FreeRockGradeSystem, RockClimbKind };
export { climbingGradeProgressionSchema };
export type ClimbingGradeProgressionRow = ClimbingGradeProgressionLane;
export interface AttachedRockClimbingObservation {
  activityId: string;
  date: string;
  climbKind: RockClimbKind;
  attemptScope: "climb" | "pitch";
  displayGrade: ReturnType<typeof displayClimbingGrade>;
  recordedAttempts: number | null;
  sends: number;
  observedOutcomes: number;
  unknownOutcomes: number;
}
export class ClimbingGradeProgression {
  readonly #row: ClimbingGradeProgressionRow;
  constructor(row: ClimbingGradeProgressionRow) {
    this.#row = row;
  }
  toDetail() {
    return this.#row;
  }
}
export interface ClimbingVolumeByGradeRow {
  climbKind: RockClimbKind;
  gradeSystem: FreeRockGradeSystem;
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
  toDetail() {
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
  toDetail() {
    return this.#row;
  }
}
const rockKindSchema = z.enum(["boulder", "route"]);
const freeRockSystemSchema = z.enum(FREE_ROCK_GRADE_SYSTEMS);
export const climbingVolumeByGradeSchema = z.object({
  climbKind: rockKindSchema,
  gradeSystem: freeRockSystemSchema,
  grade: z.string(),
  gradeSortValue: z.number(),
  attempts: z.number().nullable(),
  recordedAttempts: z.number().nullable(),
  sends: z.number(),
}) satisfies z.ZodType<ClimbingVolumeByGradeRow>;
export const climbingSessionSummarySchema = z.object({
  activityId: z.string(),
  date: z.string(),
  name: z.string(),
  locationName: z.string().nullable(),
  attempts: z.number().nullable(),
  sends: z.number(),
  hardestBoulderGrade: z.string().nullable(),
  hardestBoulderGradeSortValue: z.number().nullable(),
  hardestRouteGrade: z.string().nullable(),
  hardestRouteGradeSortValue: z.number().nullable(),
}) satisfies z.ZodType<ClimbingSessionSummaryRow>;
const progressionRowSchema = z.object({
  session_date: dateStringSchema,
  climb_kind: rockKindSchema,
  attempt_scope: attemptScopeSchema,
  setting: z.enum(climbingProgressionSettings),
  grade_system: freeRockSystemSchema,
  grade: z.string(),
  attempt_observations: z.array(
    z.object({
      ropeMethod: ropeMethodSchema.nullable(),
      solo: z.boolean().nullable(),
      usedAid: z.boolean().nullable(),
      sends: z.number(),
      unknownOutcomes: z.number(),
    }),
  ),
});
const volumeRowSchema = z.object({
  climb_kind: rockKindSchema,
  grade_system: freeRockSystemSchema,
  grade: z.string(),
  attempts: z.coerce.number().nullable(),
  recorded_attempts: z.coerce.number().nullable(),
  sends: z.coerce.number(),
});
const sessionRowSchema = z.object({
  activity_id: z.string(),
  session_date: dateStringSchema,
  name: z.string(),
  location_name: z.string().nullable(),
  attempt_count: z.coerce.number().nullable(),
  sends: z.coerce.number(),
  climb_kind: rockKindSchema,
  grade_system: freeRockSystemSchema.nullable(),
  grade: z.string().nullable(),
});
const attachedRockObservationSchema = z.object({
  activity_id: z.string(),
  session_date: dateStringSchema,
  climb_kind: rockKindSchema,
  attempt_scope: attemptScopeSchema,
  grade_system: freeRockSystemSchema.nullable(),
  grade: z.string().nullable(),
  attempt_count: z.coerce.number().nullable(),
  sends: z.coerce.number(),
  observed_outcomes: z.coerce.number(),
  unknown_outcomes: z.coerce.number(),
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
  #canonicalLogCtes(
    range: number | { startDate: string; endDate: string },
    filters: ClimbingFilters,
  ) {
    const activityDate = postgresActivityCalendarDate(sql`a`, this.timezone);
    const datePredicate = (date: SQL) =>
      typeof range === "number"
        ? sql`(${date}) > (NOW() AT TIME ZONE ${this.timezone})::date - ${range}::int AND (${date}) <= (NOW() AT TIME ZONE ${this.timezone})::date`
        : sql`(${date}) BETWEEN ${range.startDate}::date AND ${range.endDate}::date`;
    return sql`rock_logs AS (${rockClimbingLogProjection(this.#gradePreference, filters)}),
      dated_logs AS (
        SELECT (${activityDate})::text AS session_date, a.id AS canonical_activity_id,
          a.name AS activity_name, ce.*
        FROM fitness.v_activity AS a JOIN rock_logs AS ce ON ce.activity_id = ANY(a.member_activity_ids)
        WHERE a.user_id = ${this.userId} AND ce.user_id = ${this.userId}
          AND a.canonical_type IN ('climbing', 'hiking')
          AND ${datePredicate(activityDate)}
          ${this.dateAccessPredicate(activityDate)}
        UNION ALL
        SELECT ce.climbed_on::text AS session_date, NULL::uuid AS canonical_activity_id,
          NULL::text AS activity_name, ce.* FROM rock_logs AS ce
        WHERE ce.user_id = ${this.userId} AND ce.activity_id IS NULL
          AND ${datePredicate(sql`ce.climbed_on`)}
          ${this.dateAccessPredicate(sql`ce.climbed_on`)}
      ), observations AS (
        SELECT ce.*, CASE WHEN ce.canonical_activity_id IS NOT NULL
          AND NULLIF(BTRIM(ce.climb_name), '') IS NOT NULL AND jsonb_array_length(ce.area_path) > 0
          AND (ce.attempt_scope = 'climb' OR ce.pitch_number IS NOT NULL)
          THEN jsonb_build_array(ce.canonical_activity_id, ce.session_date, ce.climb_kind,
            ce.grade_system, LOWER(BTRIM(ce.grade)), ce.attempt_scope, ce.pitch_number, ce.rope_method,
            ce.solo, ce.setting, LOWER(BTRIM(ce.climb_name)),
            (SELECT jsonb_agg(LOWER(BTRIM(node->>'name')) ORDER BY position)
              FROM jsonb_array_elements(ce.area_path) WITH ORDINALITY AS location(node, position)),
            LOWER(BTRIM(ce.board->>'name')), ce.wall_angle, ce.route_protection, ce.recorded_free_send)
          ELSE jsonb_build_array(ce.id, ce.pitch_id, ce.unknown_pitch_attempt_id) END AS observation
        FROM dated_logs AS ce
      ), ranked_observations AS (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY observation, provider_id ORDER BY recorded_attempt_count DESC, id) AS occurrence
        FROM observations
      ), canonical_logs AS (
        SELECT DISTINCT ON (observation, occurrence) *,
          CASE WHEN MIN(recorded_attempt_count) OVER paired = MAX(recorded_attempt_count) OVER paired
            THEN MAX(recorded_attempt_count) OVER paired END AS canonical_attempt_count
        FROM ranked_observations WINDOW paired AS (PARTITION BY observation, occurrence)
        ORDER BY observation, occurrence, provider_id, id
      )`;
  }
  async getGradeProgression(
    days: number,
    filters: ClimbingFilters = {},
  ): Promise<ClimbingGradeProgression[]> {
    const rows = await executeWithSchema(
      this.db,
      progressionRowSchema,
      sql`WITH ${this.#canonicalLogCtes(days, filters)}
      SELECT session_date, climb_kind, attempt_scope, COALESCE(setting::text, 'unknown') AS setting,
        grade_system, grade, attempt_observations FROM canonical_logs WHERE grade IS NOT NULL`,
    );
    const entries = rows.flatMap((row): ClimbingProgressionEntry[] => {
      const display = displayClimbingGrade(
        this.#gradePreference,
        row.climb_kind,
        row.grade_system,
        row.grade,
      );
      return display
        ? row.attempt_observations.map((attempt) => ({
            date: row.session_date,
            climbKind: row.climb_kind,
            attemptScope: row.attempt_scope,
            setting: row.setting,
            ...attempt,
            ...display,
          }))
        : [];
    });
    return buildClimbingGradeProgression(entries).map((row) => new ClimbingGradeProgression(row));
  }
  async getVolumeByGrade(
    days: number,
    filters: ClimbingFilters = {},
  ): Promise<ClimbingVolumeByGrade[]> {
    const rows = await executeWithSchema(
      this.db,
      volumeRowSchema,
      sql`WITH ${this.#canonicalLogCtes(days, filters)}
      SELECT climb_kind, grade_system, grade,
        CASE WHEN COUNT(canonical_attempt_count) = COUNT(*) THEN SUM(canonical_attempt_count) END AS attempts,
        SUM(canonical_attempt_count) AS recorded_attempts, SUM(sends)::int AS sends
      FROM canonical_logs WHERE grade IS NOT NULL GROUP BY climb_kind, grade_system, grade`,
    );
    const byGrade = new Map<string, ClimbingVolumeByGradeRow>();
    for (const row of rows) {
      const display = displayClimbingGrade(
        this.#gradePreference,
        row.climb_kind,
        row.grade_system,
        row.grade,
      );
      if (!display) continue;
      const key = `${row.climb_kind}:${display.gradeSystem}:${display.grade}`;
      const current = byGrade.get(key);
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
      } else
        byGrade.set(key, {
          climbKind: row.climb_kind,
          ...display,
          attempts: row.attempts,
          recordedAttempts: row.recorded_attempts,
          sends: row.sends,
        });
    }
    return [...byGrade.values()]
      .sort((a, b) => a.gradeSortValue - b.gradeSortValue)
      .map((row) => new ClimbingVolumeByGrade(row));
  }
  async getSessionSummaries(
    days: number,
    filters: ClimbingFilters = {},
  ): Promise<ClimbingSessionSummary[]> {
    const rows = await executeWithSchema(
      this.db,
      sessionRowSchema,
      sql`WITH ${this.#canonicalLogCtes(days, filters)}
      SELECT canonical_activity_id::text AS activity_id, session_date, COALESCE(activity_name, 'Climbing') AS name,
        location_name, canonical_attempt_count AS attempt_count, sends, climb_kind, grade_system, grade
      FROM canonical_logs WHERE canonical_activity_id IS NOT NULL`,
    );
    const summaries = new Map<string, ClimbingSessionSummaryRow>();
    for (const row of rows) {
      const current = summaries.get(row.activity_id) ?? {
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
      current.locationName ??= row.location_name;
      current.attempts =
        current.attempts === null || row.attempt_count === null
          ? null
          : current.attempts + row.attempt_count;
      current.sends += row.sends;
      const display =
        row.sends > 0 && row.grade_system !== null && row.grade !== null
          ? displayClimbingGrade(this.#gradePreference, row.climb_kind, row.grade_system, row.grade)
          : null;
      if (
        display &&
        row.climb_kind === "boulder" &&
        (current.hardestBoulderGradeSortValue === null ||
          display.gradeSortValue > current.hardestBoulderGradeSortValue)
      ) {
        current.hardestBoulderGrade = display.grade;
        current.hardestBoulderGradeSortValue = display.gradeSortValue;
      }
      if (
        display &&
        row.climb_kind === "route" &&
        (current.hardestRouteGradeSortValue === null ||
          display.gradeSortValue > current.hardestRouteGradeSortValue)
      ) {
        current.hardestRouteGrade = display.grade;
        current.hardestRouteGradeSortValue = display.gradeSortValue;
      }
      summaries.set(row.activity_id, current);
    }
    return [...summaries.values()]
      .sort((a, b) => b.date.localeCompare(a.date))
      .map((row) => new ClimbingSessionSummary(row));
  }
  getActivityLogEntries(activityId: string): Promise<ClimbingActivityLogEntry[]> {
    return new ClimbingActivityLogEntryRepository(
      this.db,
      this.userId,
      this.timezone,
      this.accessWindow,
      this.#gradePreference,
    ).getActivityLogEntries(activityId);
  }
  async getAttachedRockObservations(
    startDate: string,
    endDate: string,
  ): Promise<AttachedRockClimbingObservation[]> {
    const rows = await executeWithSchema(
      this.db,
      attachedRockObservationSchema,
      sql`WITH ${this.#canonicalLogCtes({ startDate, endDate }, {})}
      SELECT canonical_activity_id::text AS activity_id, session_date, climb_kind, attempt_scope, grade_system, grade,
        canonical_attempt_count AS attempt_count, sends, recorded_attempt_count - unknown_outcomes AS observed_outcomes,
        unknown_outcomes FROM canonical_logs WHERE canonical_activity_id IS NOT NULL`,
    );
    return rows.map((row) => ({
      activityId: row.activity_id,
      date: row.session_date,
      climbKind: row.climb_kind,
      attemptScope: row.attempt_scope,
      displayGrade:
        row.grade_system === null || row.grade === null
          ? null
          : displayClimbingGrade(
              this.#gradePreference,
              row.climb_kind,
              row.grade_system,
              row.grade,
            ),
      recordedAttempts: row.attempt_count,
      sends: row.sends,
      observedOutcomes: row.observed_outcomes,
      unknownOutcomes: row.unknown_outcomes,
    }));
  }
}
