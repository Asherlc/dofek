import { climbingContextSchema } from "@dofek/training/climbing-context";
import {
  CLIMBING_GRADE_SYSTEMS,
  type ClimbingGradePreference,
  DEFAULT_CLIMBING_GRADE_PREFERENCE,
} from "@dofek/training/climbing-grades";
import { sql } from "drizzle-orm";
import { z } from "zod";
import {
  type ClimbingActivityEntryRow,
  climbingActivityEntryDetailSchema,
} from "../contracts/climbing-context-contracts.ts";
import { BaseRepository } from "../lib/base-repository.ts";
import { executeWithSchema } from "../lib/typed-sql.ts";
import { displayClimbingGrade } from "./climbing-grade-display.ts";

const climbTypeSchema = z.enum(["boulder", "route"]);
const gradeSystemSchema = z.enum(CLIMBING_GRADE_SYSTEMS);
const ascentTypeSchema = z.enum(["Flash", "Onsight", "Redpoint", "Pinkpoint", "Repeat"]);
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

export class ClimbingActivityEntryRepository extends BaseRepository {
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
        const display = displayClimbingGrade(
          this.#gradePreference,
          row.climb_type,
          row.grade_system,
          row.grade,
        );
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
