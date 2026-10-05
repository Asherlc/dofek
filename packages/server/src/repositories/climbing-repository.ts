import { climbingContextSchema } from "@dofek/training/climbing-context";
import type { ClimbingFilters } from "@dofek/training/climbing-filters";
import {
  CLIMBING_GRADE_SYSTEMS,
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
import {
  type ClimbingActivityEntryRow,
  climbingActivityEntryDetailSchema,
} from "../contracts/climbing-context-contracts.ts";
import { BaseRepository } from "../lib/base-repository.ts";
import { dateStringSchema, executeWithSchema } from "../lib/typed-sql.ts";
import { postgresActivityCalendarDate } from "./activity-local-date.ts";

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
export const climbingGradeProgressionSchema = z.object({
  date: z.string(),
  climbType: climbTypeSchema,
  gradeSystem: gradeSystemSchema,
  grade: z.string(),
  gradeSortValue: z.number(),
}) satisfies z.ZodType<ClimbingGradeProgressionRow>;
export const climbingVolumeByGradeSchema = climbingGradeProgressionSchema
  .omit({ date: true })
  .extend({
    attempts: z.number().nullable(),
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
const ascentTypeSchema = z.enum(["Flash", "Onsight", "Redpoint", "Pinkpoint", "Repeat"]);
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
const activityEntryRowSchema = z.object({
  id: z.string(),
  provider_id: z.string(),
  context: climbingContextSchema,
  climb_type: climbTypeSchema,
  grade_system: gradeSystemSchema,
  grade: z.string(),
  sent: z.boolean().nullable(),
  attempt_count: z.coerce.number().int().positive().nullable(),
  attempts: climbingActivityEntryDetailSchema.shape.attempts,
  ascent_type: ascentTypeSchema.nullable(),
  hold_type: climbingActivityEntryDetailSchema.shape.holdType,
  route_name: z.string().nullable(),
  location_name: z.string().nullable(),
  lead: z.boolean().nullable().default(null),
  source_name: z.string().nullable(),
  wall_angle_degrees: z.coerce.number().nullable(),
});
type ClimbingActivityEntryDatabaseRow = z.infer<typeof activityEntryRowSchema>;

function climbingIdentity(row: ClimbingActivityEntryDatabaseRow): string | null {
  if (!row.route_name || !row.location_name) return null;
  return JSON.stringify([
    row.climb_type,
    row.grade_system,
    row.grade.trim().replace(/\s+/g, " ").toLocaleLowerCase(),
    row.route_name.trim().replace(/\s+/g, " ").toLocaleLowerCase(),
    row.location_name.trim().replace(/\s+/g, " ").toLocaleLowerCase(),
    row.lead,
  ]);
}

function compareDetailCompleteness(
  left: ClimbingActivityEntryDatabaseRow,
  right: ClimbingActivityEntryDatabaseRow,
): number {
  const completeness: Array<readonly [number, number]> = [
    [Number(left.sent !== null), Number(right.sent !== null)],
    [Number(left.attempt_count !== null), Number(right.attempt_count !== null)],
    [left.attempts.length, right.attempts.length],
  ];
  for (const [leftValue, rightValue] of completeness) {
    if (leftValue !== rightValue) return leftValue - rightValue;
  }
  return 0;
}

function deduplicateCrossProviderEntries(
  rows: ClimbingActivityEntryDatabaseRow[],
): ClimbingActivityEntryDatabaseRow[] {
  const result: ClimbingActivityEntryDatabaseRow[] = [];
  const byIdentity = new Map<
    string,
    Array<{ entry: ClimbingActivityEntryDatabaseRow; providers: Set<string>; sources: Set<string> }>
  >();
  for (const row of rows) {
    const identity = climbingIdentity(row);
    if (identity === null) {
      result.push(row);
      continue;
    }
    const candidates = byIdentity.get(identity) ?? [];
    const match = candidates.find((candidate) => !candidate.providers.has(row.provider_id));
    if (!match) {
      const sources = new Set(row.source_name ? [row.source_name] : []);
      candidates.push({ entry: row, providers: new Set([row.provider_id]), sources });
      byIdentity.set(identity, candidates);
      result.push(row);
      continue;
    }
    const duplicate = match.entry;
    match.providers.add(row.provider_id);
    if (row.source_name) match.sources.add(row.source_name);
    const preferred = compareDetailCompleteness(row, duplicate) > 0 ? row : duplicate;
    Object.assign(duplicate, preferred, {
      provider_id: duplicate.provider_id,
      source_name: match.sources.size > 0 ? [...match.sources].join(", ") : null,
    });
  }
  return result;
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
    // Location kinds are recorded source facts; provider identity and missing paths do not establish setting.
    const setting = sql`CASE
      WHEN ce.location_path @> '[{"kind":"gym"}]'::jsonb THEN 'indoor'
      WHEN ce.location_path @> '[{"kind":"destination"}]'::jsonb
        OR ce.location_path @> '[{"kind":"area"}]'::jsonb
        OR ce.location_path @> '[{"kind":"subarea"}]'::jsonb THEN 'outdoor'
      ELSE 'unknown' END`;
    if (filters.setting) predicates.push(sql`(${setting}) = ${filters.setting}`);
    return sql.join(predicates, sql` AND `);
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

  async getGradeProgression(
    days: number,
    filters: ClimbingFilters = {},
  ): Promise<ClimbingGradeProgression[]> {
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
              AND ${this.#entryFilterPredicate(filters)}
            UNION ALL
            SELECT
              ce.unattached_date::text AS session_date,
              ce.id, ce.activity_id, ce.climb_type, ce.grade_system, ce.grade,
              ce.sent, ce.attempt_count
            FROM fitness.v_climbing_entry AS ce
            WHERE ce.user_id = ${this.userId}
              AND ce.activity_id IS NULL
              AND ${this.#entryFilterPredicate(filters)}
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

  async getVolumeByGrade(
    days: number,
    filters: ClimbingFilters = {},
  ): Promise<ClimbingVolumeByGrade[]> {
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
              AND ${this.#entryFilterPredicate(filters)}
            UNION ALL
            SELECT
              ce.id, ce.activity_id, ce.climb_type, ce.grade_system, ce.grade,
              ce.sent, ce.attempt_count
            FROM fitness.v_climbing_entry AS ce
            WHERE ce.user_id = ${this.userId}
              AND ce.activity_id IS NULL
              AND ${this.#entryFilterPredicate(filters)}
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
      const display = this.#displayGrade(row.climb_type, row.grade_system, row.grade);
      if (!display) continue;
      const key = `${row.climb_type}:${display.gradeSystem}:${display.grade}`;
      const current = byDisplayGrade.get(key);
      if (current) {
        current.attempts =
          current.attempts === null || row.attempts === null
            ? null
            : current.attempts + row.attempts;
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

  async getSessionSummaries(
    days: number,
    filters: ClimbingFilters = {},
  ): Promise<ClimbingSessionSummary[]> {
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
          WHERE ${this.#activityWindowPredicate(days)}
              AND ${this.#entryFilterPredicate(filters)}`,
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
            source_activity.provider_id,
            jsonb_build_object('providerId', ce.provider_id, 'locationPath', ce.location_path,
              'board', ce.board, 'wallAngle', ce.wall_angle, 'climbStyle', ce.climb_style,
              'resultStyle', ce.result_style) AS context,
            ce.climb_type,
            ce.grade_system,
            ce.grade,
            CASE WHEN detail.attempt_count > 0 THEN detail.sent ELSE ce.sent END AS sent,
            CASE WHEN detail.attempt_count > 0 THEN detail.attempt_count ELSE ce.attempt_count END AS attempt_count,
            COALESCE(detail.attempts, '[]'::jsonb) AS attempts,
            ce.ascent_type,
            ce.hold_type,
            ce.route_name,
            ce.location_name,
            ce.lead,
            ce.source_name,
            ce.wall_angle_degrees
          FROM fitness.v_activity AS a
          JOIN fitness.v_climbing_entry AS ce
            ON ce.activity_id = ANY(a.member_activity_ids)
           AND ce.provider_absent_at IS NULL
          JOIN fitness.activity AS source_activity ON source_activity.id = ce.activity_id
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
            AND a.id = ${activityId}::uuid
            ${this.timestampAccessPredicate(sql`a.started_at`)}`,
    );
    return deduplicateCrossProviderEntries(rows)
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
      .sort(
        (left, right) =>
          right.display.gradeSortValue - left.display.gradeSortValue ||
          left.row.id.localeCompare(right.row.id),
      )
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
            context: row.context,
            holdType: row.hold_type,
            routeName: row.route_name,
            locationName: row.location_name,
            lead: row.lead,
            sourceName: row.source_name,
            wallAngleDegrees: row.wall_angle_degrees,
          }),
      );
  }
}
