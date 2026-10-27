import type { ClimbingFilters } from "@dofek/training/climbing-filters";
import {
  type ClimbingGradePreference,
  DEFAULT_CLIMBING_GRADE_PREFERENCE,
  FREE_ROCK_GRADE_SYSTEMS,
  type FreeRockGradeSystem,
  type RockClimbKind,
} from "@dofek/training/climbing-grades";
import {
  type ClimbingLocationMapEntry,
  climbingMapLocationSchema,
} from "@dofek/training/climbing-location-map";
import {
  attemptScopeSchema,
  climbingLogEntryName,
  ropeMethodSchema,
} from "@dofek/training/climbing-log";
import {
  type ClimbingGradeProgressionLane,
  climbingGradeProgressionSchema,
  climbingProgressionSettings,
} from "@dofek/training/climbing-progression";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { ClimbingLogEntryDetail } from "../contracts/climbing-log-contracts.ts";
import { BaseRepository } from "../lib/base-repository.ts";
import { dateStringSchema, executeWithSchema } from "../lib/typed-sql.ts";
import {
  type ClimbingActivityLogEntry,
  ClimbingActivityLogEntryRepository,
} from "./climbing-activity-log-entry-repository.ts";
import { canonicalClimbingLogCtes } from "./climbing-canonical-observations.ts";
import { displayClimbingGrade } from "./climbing-grade-display.ts";
import {
  buildClimbingGradeProgression,
  type ClimbingProgressionEntry,
} from "./climbing-grade-progression.ts";

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
const mapEntryRowSchema = z.object({
  id: z.string(),
  activity_id: z.string().nullable(),
  session_date: dateStringSchema,
  climb_name: z.string().nullable(),
  title: z.string().nullable(),
  provider_id: z.string(),
  raw: z.json().nullable(),
  climb_kind: rockKindSchema,
  grade_system: freeRockSystemSchema.nullable(),
  grade: z.string().nullable(),
  location: climbingMapLocationSchema,
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
    return canonicalClimbingLogCtes(
      range,
      filters,
      this.#gradePreference,
      this.userId,
      this.timezone,
      (date) => this.dateAccessPredicate(date),
    );
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
  async getMapEntries(
    days: number,
    filters: ClimbingFilters = {},
  ): Promise<ClimbingLocationMapEntry[]> {
    const rows = await executeWithSchema(
      this.db,
      mapEntryRowSchema,
      sql`WITH ${this.#canonicalLogCtes(days, filters)}
      SELECT DISTINCT ON (ce.id) ce.id::text AS id,
        ce.canonical_activity_id::text AS activity_id, ce.session_date,
        ce.climb_name, ce.title, ce.provider_id, ce.raw,
        ce.climb_kind, ce.grade_system, ce.grade,
        CASE WHEN ce.coordinates IS NOT NULL THEN jsonb_build_object(
          'coordinates', jsonb_build_object('latitude', ce.coordinates[1], 'longitude', ce.coordinates[0]),
          'scope', 'climb', 'objectId', ce.climb_id, 'providerId', ce.provider_id, 'name', ce.climb_name)
        ELSE jsonb_build_object(
          'coordinates', nearest_area.node->'coordinates', 'scope', 'area',
          'objectId', nearest_area.node->>'id', 'providerId', nearest_area.node->>'providerId',
          'name', nearest_area.node->>'name') END AS location
      FROM canonical_logs AS ce
      LEFT JOIN LATERAL (
        SELECT node FROM jsonb_array_elements(ce.area_path) WITH ORDINALITY AS path(node, position)
        WHERE node->'coordinates' IS NOT NULL AND node->'coordinates' <> 'null'::jsonb
        ORDER BY position DESC LIMIT 1
      ) AS nearest_area ON true
      WHERE ce.coordinates IS NOT NULL OR nearest_area.node IS NOT NULL
      ORDER BY ce.id, ce.pitch_number NULLS FIRST, ce.pitch_id, ce.unknown_pitch_attempt_id`,
    );
    return rows.map((row) => ({
      id: row.id,
      activityId: row.activity_id,
      date: row.session_date,
      label: climbingLogEntryName({
        providerId: row.provider_id,
        raw: row.raw,
        title: row.title,
        climb: { name: row.climb_name, kind: row.climb_kind },
      }),
      grade:
        row.grade_system === null || row.grade === null
          ? null
          : (displayClimbingGrade(
              this.#gradePreference,
              row.climb_kind,
              row.grade_system,
              row.grade,
            )?.grade ?? null),
      location: row.location,
    }));
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
