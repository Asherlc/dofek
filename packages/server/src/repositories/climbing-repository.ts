import { climbingMetadataSchema } from "@dofek/training/climbing-context";
import type { ClimbingFilters } from "@dofek/training/climbing-filters";
import {
  CLIMBING_GRADE_SYSTEMS,
  type ClimbingClimbType,
  type ClimbingGradePreference,
  type ClimbingGradeSystem,
  DEFAULT_CLIMBING_GRADE_PREFERENCE,
} from "@dofek/training/climbing-grades";
import {
  type ClimbingGradeProgressionLane,
  climbingGradeProgressionSchema,
  climbingProgressionSettings,
} from "@dofek/training/climbing-progression";
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
import {
  buildClimbingGradeProgression,
  type ClimbingProgressionEntry,
} from "./climbing-grade-progression.ts";

export type { ClimbingActivityEntryRow, ClimbingClimbType, ClimbingGradeSystem };
export { climbingGradeProgressionSchema };

export type ClimbingGradeProgressionRow = ClimbingGradeProgressionLane;

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
export const climbingVolumeByGradeSchema = z.object({
  climbType: climbTypeSchema,
  gradeSystem: gradeSystemSchema,
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
  climb_type: climbTypeSchema,
  climb_style: climbingMetadataSchema.shape.climbStyle,
  setting: z.enum(climbingProgressionSettings),
  grade_system: gradeSystemSchema,
  grade: z.string(),
  sent: z.boolean().nullable(),
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

  #entryFilterPredicate(filters: ClimbingFilters) {
    const predicates = [sql`true`];
    if (filters.style === "boulder" || filters.style === "route")
      predicates.push(sql`ce.climb_type = ${filters.style}`);
    else if (filters.style === "unknown")
      predicates.push(sql`ce.climb_type = 'route' AND ce.climb_style IS NULL`);
    else if (filters.style) predicates.push(sql`ce.climb_style = ${filters.style}`);
    if (filters.protection === "unknown") predicates.push(sql`ce.route_protection IS NULL`);
    else if (filters.protection)
      predicates.push(sql`${filters.protection} = ANY(ce.route_protection)`);
    if (filters.setting) predicates.push(sql`(${this.#entrySetting()}) = ${filters.setting}`);
    return sql.join(predicates, sql` AND `);
  }

  #entrySetting() {
    // Product policy treats Mountain Project and OpenBeta as outdoor, including older entries without paths.
    return sql`CASE
      WHEN ce.provider_id IN ('mountain-project', 'openbeta') THEN 'outdoor'
      WHEN ce.location_path @> '[{"kind":"gym"}]'::jsonb THEN 'indoor'
      WHEN ce.location_path @> '[{"kind":"destination"}]'::jsonb
        OR ce.location_path @> '[{"kind":"area"}]'::jsonb
        OR ce.location_path @> '[{"kind":"subarea"}]'::jsonb THEN 'outdoor'
      ELSE 'unknown' END`;
  }

  #canonicalEntryCtes(days: number, filters: ClimbingFilters) {
    return sql`climbing_entries AS (
            SELECT
              (${postgresActivityCalendarDate(sql`a`, this.timezone)})::text AS session_date,
              a.id AS canonical_activity_id, ce.id, ce.provider_id,
              ce.climb_type, ce.grade_system, ce.grade,
              ce.climb_style, ${this.#entrySetting()} AS setting, ce.sent,
              ce.route_name, ce.location_path, ce.board, ce.wall_angle, ce.route_protection,
              a.name AS activity_name, ce.location_name, ce.attempt_count
            FROM fitness.v_activity AS a
            JOIN fitness.v_climbing_entry AS ce
              ON ce.activity_id = ANY(a.member_activity_ids)
             AND ce.provider_absent_at IS NULL
            WHERE ${this.#activityWindowPredicate(days)}
              AND ${this.#entryFilterPredicate(filters)}
            UNION ALL
            SELECT
              ce.unattached_date::text AS session_date,
              NULL::uuid AS canonical_activity_id, ce.id, ce.provider_id,
              ce.climb_type, ce.grade_system, ce.grade,
              ce.climb_style, ${this.#entrySetting()} AS setting, ce.sent,
              ce.route_name, ce.location_path, ce.board, ce.wall_angle, ce.route_protection,
              NULL::text AS activity_name, ce.location_name, ce.attempt_count
            FROM fitness.v_climbing_entry AS ce
            WHERE ce.user_id = ${this.userId}
              AND ce.activity_id IS NULL
              AND ${this.#entryFilterPredicate(filters)}
              AND ce.provider_absent_at IS NULL
              AND ce.unattached_date > (NOW() AT TIME ZONE ${this.timezone})::date - ${days}::int
              AND ce.unattached_date <= (NOW() AT TIME ZONE ${this.timezone})::date
              ${this.dateAccessPredicate(sql`ce.unattached_date`)}
          ), recorded_entries AS (
            SELECT ce.*,
              CASE WHEN detail.attempt_count > 0 THEN detail.sent ELSE ce.sent END AS recorded_sent,
              CASE WHEN detail.attempt_count > 0 THEN detail.attempt_count ELSE ce.attempt_count END AS recorded_attempt_count
            FROM climbing_entries AS ce
            LEFT JOIN LATERAL (
              SELECT COUNT(*)::int AS attempt_count, BOOL_OR(attempt.outcome = 'sent') AS sent
              FROM fitness.climbing_attempt AS attempt
              WHERE attempt.climbing_entry_id = ce.id
            ) AS detail ON true
          ), observations AS (
            SELECT ce.*,
              CASE WHEN ce.canonical_activity_id IS NOT NULL
                AND NULLIF(BTRIM(ce.route_name), '') IS NOT NULL
                AND jsonb_array_length(ce.location_path) > 0
              THEN jsonb_build_array(
                ce.canonical_activity_id, ce.session_date,
                ce.climb_type, ce.grade_system, LOWER(BTRIM(ce.grade)),
                ce.climb_style, ce.setting, LOWER(BTRIM(ce.route_name)),
                (SELECT jsonb_agg(jsonb_build_array(LOWER(BTRIM(node->>'name')), node->>'kind') ORDER BY position)
                  FROM jsonb_array_elements(ce.location_path) WITH ORDINALITY AS location(node, position)),
                LOWER(BTRIM(ce.board->>'name')), ce.wall_angle, ce.route_protection,
                ce.recorded_sent
              ) ELSE jsonb_build_array(ce.id) END AS observation
            FROM recorded_entries AS ce
          ), ranked_observations AS (
            SELECT *, ROW_NUMBER() OVER (
              PARTITION BY observation, provider_id ORDER BY recorded_attempt_count DESC NULLS LAST, id
            ) AS occurrence
            FROM observations
          ), canonical_entries AS (
            SELECT DISTINCT ON (observation, occurrence) *,
              CASE WHEN MIN(recorded_attempt_count) OVER paired = MAX(recorded_attempt_count) OVER paired
                THEN MAX(recorded_attempt_count) OVER paired ELSE NULL END AS canonical_attempt_count
            FROM ranked_observations
            WINDOW paired AS (PARTITION BY observation, occurrence)
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
      sql`WITH ${this.#canonicalEntryCtes(days, filters)}
          SELECT
            session_date, climb_type, climb_style, setting, grade_system, grade,
            recorded_sent AS sent
          FROM canonical_entries`,
    );
    const entries = rows.flatMap((row): ClimbingProgressionEntry[] => {
      const display = displayClimbingGrade(
        this.#gradePreference,
        row.climb_type,
        row.grade_system,
        row.grade,
      );
      return display
        ? [
            {
              date: row.session_date,
              climbType: row.climb_type,
              style: row.climb_type === "boulder" ? "boulder" : (row.climb_style ?? "unknown"),
              setting: row.setting,
              sent: row.sent,
              ...display,
            },
          ]
        : [];
    });
    return buildClimbingGradeProgression(entries).map((lane) => new ClimbingGradeProgression(lane));
  }

  async getVolumeByGrade(
    days: number,
    filters: ClimbingFilters = {},
  ): Promise<ClimbingVolumeByGrade[]> {
    const rows = await executeWithSchema(
      this.db,
      volumeByGradeRowSchema,
      sql`WITH ${this.#canonicalEntryCtes(days, filters)}
          SELECT
            ce.climb_type,
            ce.grade_system,
            ce.grade,
            CASE WHEN COUNT(ce.canonical_attempt_count) = COUNT(*)
              THEN SUM(ce.canonical_attempt_count)
              ELSE NULL END AS attempts,
            SUM(ce.canonical_attempt_count) AS recorded_attempts,
            COUNT(*) FILTER (WHERE ce.recorded_sent)::int AS sends
          FROM canonical_entries AS ce
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

  async getSessionSummaries(
    days: number,
    filters: ClimbingFilters = {},
  ): Promise<ClimbingSessionSummary[]> {
    const rows = await executeWithSchema(
      this.db,
      sessionEntryRowSchema,
      sql`WITH ${this.#canonicalEntryCtes(days, filters)}
          SELECT
            ce.canonical_activity_id::text AS activity_id,
            ce.session_date,
            COALESCE(ce.activity_name, 'Climbing') AS name,
            ce.location_name,
            ce.canonical_attempt_count AS attempt_count,
            ce.recorded_sent AS sent,
            ce.climb_type,
            ce.grade_system,
            ce.grade
          FROM canonical_entries AS ce
          WHERE ce.canonical_activity_id IS NOT NULL`,
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
