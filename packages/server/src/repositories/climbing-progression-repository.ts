import { createHash } from "node:crypto";
import {
  type ClimbingFilters,
  isClimbingBoardFilterActive,
} from "@dofek/training/climbing-filters";
import {
  type ClimbingGradePreference,
  convertClimbingGrade,
  DEFAULT_CLIMBING_GRADE_PREFERENCE,
  FREE_ROCK_GRADE_SYSTEMS,
  type FreeRockGradeSystem,
  gradeSortValue,
} from "@dofek/training/climbing-grades";
import {
  attemptScopeSchema,
  climbingAttemptSchema,
  climbingHoldTypesSchema,
  ropeMethodSchema,
} from "@dofek/training/climbing-log";
import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { dateStringSchema, executeWithSchema, timestampStringSchema } from "../lib/typed-sql.ts";
import { rockClimbingLogProjection } from "./climbing-rock-observations.ts";

const rockResultLabelsSchema = z.object({
  onsight: z.boolean().nullable(),
  flash: z.boolean().nullable(),
});

const sourceExternalIdSchema = z.object({
  providerId: z.string(),
  externalId: z.string(),
  memberActivityId: z.string().optional(),
  subsource: z.string().nullable().optional(),
});

const climbingProgressionRowSchema = z.object({
  activity_id: z.string().uuid(),
  activity_name: z.string().nullable(),
  activity_started_at: timestampStringSchema,
  activity_ended_at: timestampStringSchema.nullable(),
  session_date: dateStringSchema,
  source_providers: z.array(z.string()),
  source_external_ids: z.array(sourceExternalIdSchema).nullable().default(null),
  member_activity_ids: z.array(z.string().uuid()),
  timezone: z.string().nullable(),
  start_utc_offset_minutes: z.coerce.number().int().nullable(),
  end_utc_offset_minutes: z.coerce.number().int().nullable(),
  local_time_source: z.string(),
  entry_id: z.string().uuid().nullable(),
  entry_activity_id: z.string().uuid().nullable(),
  entry_provider: z.string().nullable(),
  external_id: z.string().nullable(),
  climb_kind: z.enum(["boulder", "route"]).nullable(),
  grade_system: z.enum(FREE_ROCK_GRADE_SYSTEMS).nullable(),
  grade: z.string().nullable(),
  recorded_attempt_count: z.coerce.number().int().positive().nullable(),
  sends: z.coerce.number().int().nonnegative().nullable(),
  unknown_outcomes: z.coerce.number().int().nonnegative().nullable(),
  attempts: z.array(climbingAttemptSchema),
  attempt_observations: z.array(
    z.object({
      ropeMethod: ropeMethodSchema.nullable(),
      solo: z.boolean().nullable(),
      usedAid: z.boolean().nullable(),
      sends: z.number().int().min(0).max(1),
      unknownOutcomes: z.number().int().min(0).max(1),
      onsight: z.boolean().nullable(),
      flash: z.boolean().nullable(),
    }),
  ),
  rock_result_labels: rockResultLabelsSchema.nullable(),
  attempt_scope: attemptScopeSchema.nullable(),
  pitch_id: z.uuid().nullable(),
  pitch_number: z.coerce.number().int().positive().nullable(),
  unknown_pitch_attempt_id: z.uuid().nullable(),
  rope_method: ropeMethodSchema.nullable(),
  solo: z.boolean().nullable(),
  used_aid: z.boolean().nullable(),
  wall_angle_degrees: z.coerce.number().nullable(),
  hold_types: climbingHoldTypesSchema.nullable(),
  climb_name: z.string().nullable(),
  location_name: z.string().nullable(),
  source_name: z.string().nullable(),
});
const coverageRowSchema = z.object({ first_observed_date: dateStringSchema.nullable() });
const precedingStreakRowSchema = z.object({
  preceding_consecutive_days: z.coerce.number().int().nonnegative(),
});
const cursorSchema = z
  .object({
    version: z.literal(1),
    userId: z.string().uuid(),
    shape: z.string().min(1),
    startedAt: z.string().datetime({ offset: true }),
    activityId: z.string().uuid(),
  })
  .strict();

type ClimbingProgressionRow = z.infer<typeof climbingProgressionRowSchema>;
type ClimbRow = ClimbingProgressionRow & {
  entry_id: string;
  entry_activity_id: string;
  entry_provider: string;
  climb_kind: "boulder" | "route";
  attempt_scope: z.infer<typeof attemptScopeSchema>;
  recorded_attempt_count: number;
  sends: number;
  unknown_outcomes: number;
};
type GradedClimbRow = ClimbRow & {
  grade_system: FreeRockGradeSystem;
  grade: string;
};

export interface ClimbingProgressionInput {
  startDate: string;
  endDate: string;
  providers: string[];
  filters: ClimbingFilters;
  locations: string[];
  gradeSystems: FreeRockGradeSystem[];
  cursor: string | null;
  limit: number;
}

function shiftDate(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function datesBetween(startDate: string, endDate: string): string[] {
  const result: string[] = [];
  for (let date = startDate; date <= endDate; date = shiftDate(date, 1)) result.push(date);
  return result;
}

function unique(values: string[] | null): string[] {
  return [...new Set(values)].sort();
}

function laneFacts(row: ClimbRow) {
  return {
    climb_kind: row.climb_kind,
    attempt_scope: row.attempt_scope,
    rope_method: row.rope_method,
    solo: row.solo,
    used_aid: row.used_aid,
  };
}

function identityFingerprint(row: ClimbRow): string {
  return JSON.stringify([
    row.activity_id,
    row.climb_kind,
    row.grade_system,
    row.grade,
    row.climb_name?.trim().toLocaleLowerCase() ?? null,
    row.location_name?.trim().toLocaleLowerCase() ?? null,
    row.wall_angle_degrees,
    row.attempt_scope,
    row.pitch_number,
    row.unknown_pitch_attempt_id,
    row.rope_method,
    row.solo,
  ]);
}

function observationFingerprint(row: ClimbRow): string {
  return JSON.stringify([
    identityFingerprint(row),
    row.sends,
    row.unknown_outcomes,
    row.recorded_attempt_count,
    row.rock_result_labels,
    unique(row.hold_types),
    row.attempts
      .map((attempt) => [
        attempt.scope,
        attempt.parentAttemptId !== null,
        attempt.attemptIndex,
        attempt.outcome,
        attempt.ropeMethod,
        attempt.solo,
        attempt.protectionUsed,
        attempt.usedPreplacedProtection,
        attempt.usedAid,
        attempt.fellOrHung,
        attempt.dabbed,
        attempt.receivedBeta,
        attempt.hadCompletedBefore,
        attempt.priorFailedAttemptsGroundUp,
        attempt.notes,
      ])
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
  ]);
}

interface ConsolidatedClimb {
  row: ClimbRow;
  sourceEntryIds: string[];
  sourceActivityIds: string[];
  sourceProviders: string[];
  sourceNames: string[];
  sourceExternalEntryIds: Array<{ provider: string; external_id: string }>;
  mergedDuplicate: boolean;
}

function consolidateExactDuplicates(rows: ClimbRow[]): {
  climbs: ConsolidatedClimb[];
  mergedRecords: number;
  possibleDuplicateEntryIds: Set<string>;
  possibleDuplicateGroups: string[][];
} {
  const climbs: ConsolidatedClimb[] = [];
  const representatives = new Map<string, ConsolidatedClimb[]>();
  let mergedRecords = 0;
  for (const row of rows) {
    const observation = observationFingerprint(row);
    const candidates = representatives.get(observation) ?? [];
    const duplicate = candidates.find(
      (candidate) =>
        candidate.row.entry_activity_id !== row.entry_activity_id &&
        (!candidate.sourceProviders.includes(row.entry_provider) ||
          (row.external_id !== null &&
            candidate.sourceExternalEntryIds.some(
              (source) =>
                source.provider === row.entry_provider && source.external_id === row.external_id,
            ))),
    );
    if (duplicate) {
      duplicate.sourceEntryIds = unique([...duplicate.sourceEntryIds, row.entry_id]);
      duplicate.sourceActivityIds = unique([...duplicate.sourceActivityIds, row.entry_activity_id]);
      duplicate.sourceProviders = unique([...duplicate.sourceProviders, row.entry_provider]);
      duplicate.sourceNames = unique([
        ...duplicate.sourceNames,
        ...(row.source_name ? [row.source_name] : []),
      ]);
      if (row.external_id !== null) {
        duplicate.sourceExternalEntryIds = [
          ...duplicate.sourceExternalEntryIds,
          { provider: row.entry_provider, external_id: row.external_id },
        ];
      }
      duplicate.mergedDuplicate = true;
      mergedRecords += 1;
      continue;
    }
    const consolidated: ConsolidatedClimb = {
      row,
      sourceEntryIds: [row.entry_id],
      sourceActivityIds: [row.entry_activity_id],
      sourceProviders: [row.entry_provider],
      sourceNames: row.source_name ? [row.source_name] : [],
      sourceExternalEntryIds:
        row.external_id === null
          ? []
          : [{ provider: row.entry_provider, external_id: row.external_id }],
      mergedDuplicate: false,
    };
    climbs.push(consolidated);
    representatives.set(observation, [...candidates, consolidated]);
  }

  const byIdentity = new Map<string, ConsolidatedClimb[]>();
  for (const climb of climbs) {
    const identity = identityFingerprint(climb.row);
    byIdentity.set(identity, [...(byIdentity.get(identity) ?? []), climb]);
  }
  const duplicateGroups = new Map<string, string[]>();
  const addDuplicateGroup = (matching: ConsolidatedClimb[]) => {
    const entryIds = unique(matching.flatMap((climb) => climb.sourceEntryIds));
    if (entryIds.length > 1) duplicateGroups.set(entryIds.join(":"), entryIds);
  };
  for (const matching of byIdentity.values()) {
    if (matching.length < 2) continue;
    if (unique(matching.flatMap((climb) => climb.sourceProviders)).length > 1) {
      addDuplicateGroup(matching);
    }
  }
  const byStableIdentity = new Map<string, Set<ConsolidatedClimb>>();
  for (const climb of climbs) {
    for (const source of climb.sourceExternalEntryIds) {
      const key = JSON.stringify([
        source.provider,
        source.external_id,
        climb.row.attempt_scope,
        climb.row.pitch_id,
        climb.row.unknown_pitch_attempt_id,
      ]);
      const matching = byStableIdentity.get(key) ?? new Set<ConsolidatedClimb>();
      matching.add(climb);
      byStableIdentity.set(key, matching);
    }
  }
  for (const matching of byStableIdentity.values()) {
    if (matching.size > 1) addDuplicateGroup([...matching]);
  }
  const possibleDuplicateGroups = [...duplicateGroups.values()];
  return {
    climbs,
    mergedRecords,
    possibleDuplicateEntryIds: new Set(possibleDuplicateGroups.flat()),
    possibleDuplicateGroups,
  };
}

function attemptSummary(climbs: ConsolidatedClimb[]) {
  const attempts = climbs.reduce((total, climb) => total + climb.row.recorded_attempt_count, 0);
  const unknownOutcomes = climbs.reduce((total, climb) => total + climb.row.unknown_outcomes, 0);
  const observedOutcomes = attempts - unknownOutcomes;
  const sends = climbs.reduce((total, climb) => total + climb.row.sends, 0);
  return {
    attempts: climbs.length === 0 ? null : attempts,
    attemptsStatus: climbs.length === 0 ? ("unavailable" as const) : ("complete" as const),
    entriesWithAttempts: climbs.length,
    observedOutcomes,
    unknownOutcomes,
    sends: observedOutcomes === 0 ? null : sends,
    failedAttempts:
      climbs.length === 0
        ? null
        : climbs.reduce(
            (total, climb) =>
              total + climb.row.attempts.filter((attempt) => attempt.outcome === "failed").length,
            0,
          ),
    sendRate: observedOutcomes === 0 ? null : sends / observedOutcomes,
  };
}

type GradedClimb = ConsolidatedClimb & { row: GradedClimbRow };
function hasPublishedGrade(climb: ConsolidatedClimb): climb is GradedClimb {
  return climb.row.grade !== null && climb.row.grade_system !== null;
}

function splitAttemptLanes(climb: GradedClimb): GradedClimb[] {
  const lanes = new Map<string, GradedClimb>();
  for (const [index, observation] of climb.row.attempt_observations.entries()) {
    const key = JSON.stringify([observation.ropeMethod, observation.solo, observation.usedAid]);
    const attempt = climb.row.attempts[index];
    if (!attempt) throw new Error("Climbing attempt evidence is missing its recorded row");
    const lane = lanes.get(key);
    if (lane) {
      lane.row.recorded_attempt_count += 1;
      lane.row.sends += observation.sends;
      lane.row.unknown_outcomes += observation.unknownOutcomes;
      lane.row.attempts.push(attempt);
      lane.row.rock_result_labels = {
        onsight: lane.row.rock_result_labels?.onsight === true || observation.onsight === true,
        flash: lane.row.rock_result_labels?.flash === true || observation.flash === true,
      };
    } else {
      lanes.set(key, {
        ...climb,
        row: {
          ...climb.row,
          rope_method: observation.ropeMethod,
          solo: observation.solo,
          used_aid: observation.usedAid,
          recorded_attempt_count: 1,
          sends: observation.sends,
          unknown_outcomes: observation.unknownOutcomes,
          attempts: [attempt],
          rock_result_labels: { onsight: observation.onsight, flash: observation.flash },
        },
      });
    }
  }
  return [...lanes.values()];
}

function hardestEvidence(climbs: ConsolidatedClimb[], resultLabel?: "flash" | "onsight") {
  return climbs
    .filter(hasPublishedGrade)
    .filter((climb) => {
      if (climb.row.sends === 0) return false;
      return resultLabel == null ? true : climb.row.rock_result_labels?.[resultLabel] === true;
    })
    .map((climb) => ({ climb, sort: gradeSortValue(climb.row.grade, climb.row.grade_system) }))
    .filter((candidate): candidate is { climb: GradedClimb; sort: number } =>
      Number.isFinite(candidate.sort),
    )
    .sort((left, right) => right.sort - left.sort)[0];
}

function normalizedGrade(
  row: Pick<ClimbRow, "climb_kind" | "grade" | "grade_system">,
  preference: ClimbingGradePreference,
) {
  const normalizedGradeSystem = preference[row.climb_kind];
  const converted =
    row.grade === null || row.grade_system === null
      ? null
      : convertClimbingGrade({
          grade: row.grade,
          sourceSystem: row.grade_system,
          displaySystem: normalizedGradeSystem,
        });
  return {
    normalized_grade: converted?.displayGrade ?? null,
    normalized_grade_system: normalizedGradeSystem,
  };
}

function hardestOutput(
  candidate: ReturnType<typeof hardestEvidence>,
  preference: ClimbingGradePreference,
) {
  if (!candidate) return null;
  const { row } = candidate.climb;
  return {
    grade: row.grade,
    grade_system: row.grade_system,
    ...laneFacts(row),
    date: row.session_date,
    activity_id: row.activity_id,
    entry_id: row.entry_id,
    rock_result_labels: row.rock_result_labels,
    source_providers: candidate.climb.sourceProviders,
    ...normalizedGrade(row, preference),
  };
}

function cursorShape(
  input: ClimbingProgressionInput,
  preference: ClimbingGradePreference,
  timezone: string,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        startDate: input.startDate,
        endDate: input.endDate,
        providers: [...input.providers].sort(),
        filters: Object.entries(input.filters).sort(([left], [right]) => left.localeCompare(right)),
        locations: [...input.locations].sort(),
        gradeSystems: [...input.gradeSystems].sort(),
        preference,
        timezone,
      }),
    )
    .digest("base64url")
    .slice(0, 22);
}

function decodeCursor(cursor: string | null, userId: string, shape: string) {
  if (cursor === null) return null;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error("Malformed Base64URL");
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const parsed = cursorSchema.parse(JSON.parse(decoded));
    if (parsed.userId !== userId || parsed.shape !== shape) throw new Error("Binding mismatch");
    return parsed;
  } catch {
    throw new Error("Invalid climbing progression cursor");
  }
}

function encodeCursor(row: ClimbingProgressionRow, userId: string, shape: string): string {
  return Buffer.from(
    JSON.stringify({
      version: 1,
      userId,
      shape,
      startedAt: row.activity_started_at,
      activityId: row.activity_id,
    }),
    "utf8",
  ).toString("base64url");
}

/** Server-side exact-range climbing progression over canonical activity groups. */
export class ClimbingProgressionRepository {
  readonly #db: Pick<Database, "execute">;
  readonly #userId: string;
  readonly #timezone: string;
  readonly #gradePreference: ClimbingGradePreference;

  constructor(
    db: Pick<Database, "execute">,
    userId: string,
    timezone: string,
    gradePreference: ClimbingGradePreference = DEFAULT_CLIMBING_GRADE_PREFERENCE,
  ) {
    this.#db = db;
    this.#userId = userId;
    this.#timezone = timezone;
    this.#gradePreference = gradePreference;
  }

  #localDateSql() {
    return sql`CASE
      WHEN a.local_time_source IN (
        'provider_timezone', 'device_timezone', 'user_home_timezone',
        'gps_timezone', 'home_zone_fallback'
      ) AND a.timezone IS NOT NULL
        THEN (a.started_at AT TIME ZONE a.timezone)::date
      WHEN a.local_time_source IN ('provider_offset', 'device_offset')
        AND a.start_utc_offset_minutes IS NOT NULL
        THEN ((a.started_at AT TIME ZONE 'UTC')
          + a.start_utc_offset_minutes * INTERVAL '1 minute')::date
      ELSE (a.started_at AT TIME ZONE ${this.#timezone})::date
    END`;
  }

  async listRange(input: ClimbingProgressionInput) {
    const shape = cursorShape(input, this.#gradePreference, this.#timezone);
    const cursor = decodeCursor(input.cursor, this.#userId, shape);
    const localDate = this.#localDateSql();
    const lookbackStartDate = shiftDate(input.startDate, -27);
    const providerPredicate =
      input.providers.length === 0
        ? sql`true`
        : sql`(
            ce.provider_id IN (${sql.join(
              input.providers.map((provider) => sql`${provider}`),
              sql`, `,
            )})
            OR a.source_providers && ARRAY[${sql.join(
              input.providers.map((provider) => sql`${provider}`),
              sql`, `,
            )}]::text[]
          )`;
    const projection = rockClimbingLogProjection(this.#gradePreference, input.filters);
    const requiresLog =
      isClimbingBoardFilterActive(input.filters) ||
      Object.keys(input.filters).some((key) => key !== "board") ||
      input.locations.length > 0 ||
      input.gradeSystems.length > 0;
    const activityPredicate = sql`(a.canonical_type = 'climbing' OR (a.canonical_type = 'hiking' AND ce.id IS NOT NULL))`;
    const locationPredicate =
      input.locations.length === 0
        ? sql`true`
        : sql`ce.location_name IN (${sql.join(
            input.locations.map((location) => sql`${location}`),
            sql`, `,
          )})`;
    const gradeSystemPredicate =
      input.gradeSystems.length === 0
        ? sql`true`
        : sql`ce.grade_system::text IN (${sql.join(
            input.gradeSystems.map((gradeSystem) => sql`${gradeSystem}`),
            sql`, `,
          )})`;

    const rows = await executeWithSchema(
      this.#db,
      climbingProgressionRowSchema,
      sql`SELECT
            a.id::text AS activity_id,
            a.name AS activity_name,
            a.started_at::text AS activity_started_at,
            a.ended_at::text AS activity_ended_at,
            (${localDate})::text AS session_date,
            a.source_providers,
            a.source_external_ids,
            a.member_activity_ids,
            a.timezone,
            a.start_utc_offset_minutes,
            a.end_utc_offset_minutes,
            a.local_time_source,
            ce.id::text AS entry_id,
            ce.activity_id::text AS entry_activity_id,
            ce.provider_id AS entry_provider,
            ce.external_id,
            ce.climb_kind,
            ce.grade_system,
            ce.grade,
            ce.recorded_attempt_count, ce.sends, ce.unknown_outcomes,
            COALESCE(ce.attempts, '[]'::jsonb) AS attempts,
            COALESCE(ce.attempt_observations, '[]'::jsonb) AS attempt_observations,
            ce.rock_result_labels, ce.attempt_scope, ce.pitch_id, ce.pitch_number,
            ce.unknown_pitch_attempt_id, ce.rope_method, ce.solo, ce.used_aid,
            CASE WHEN ce.wall_angle ->> 'unit' = 'degrees' THEN (ce.wall_angle ->> 'value')::double precision END AS wall_angle_degrees,
            to_jsonb(ce.hold_types) AS hold_types,
            ce.climb_name,
            ce.location_name,
            ce.source_name
          FROM fitness.v_activity AS a
          LEFT JOIN (${projection}) AS ce ON ce.activity_id = ANY(a.member_activity_ids) AND ce.user_id = a.user_id
          WHERE a.user_id = ${this.#userId}::uuid
            AND ${activityPredicate}
            AND ${localDate} BETWEEN ${lookbackStartDate}::date AND ${input.endDate}::date
            AND ${providerPredicate}
            AND (${!requiresLog} OR ce.id IS NOT NULL)
            AND ${locationPredicate}
            AND ${gradeSystemPredicate}
          ORDER BY a.started_at DESC, a.id, ce.id`,
    );

    const climbRows = rows.filter(
      (row): row is ClimbRow =>
        row.entry_id !== null &&
        row.entry_activity_id !== null &&
        row.entry_provider !== null &&
        row.climb_kind !== null &&
        row.attempt_scope !== null &&
        row.recorded_attempt_count !== null &&
        row.sends !== null &&
        row.unknown_outcomes !== null,
    );
    const {
      climbs: allClimbs,
      possibleDuplicateEntryIds,
      possibleDuplicateGroups,
    } = consolidateExactDuplicates(climbRows);
    const requestedRows = rows.filter((row) => row.session_date >= input.startDate);
    const climbs = allClimbs.filter((climb) => climb.row.session_date >= input.startDate);
    const mergedRecords = climbs.reduce(
      (total, climb) => total + Math.max(0, climb.sourceEntryIds.length - 1),
      0,
    );
    const requestedEntryIds = new Set(climbs.flatMap((climb) => climb.sourceEntryIds));
    const requestedPossibleDuplicateGroups = possibleDuplicateGroups.filter((group) =>
      group.some((entryId) => requestedEntryIds.has(entryId)),
    );
    const aggregateClimbs = climbs.filter(
      (climb) => !climb.sourceEntryIds.some((entryId) => possibleDuplicateEntryIds.has(entryId)),
    );
    const byActivity = new Map<string, ClimbingProgressionRow[]>();
    for (const row of requestedRows) {
      if (!byActivity.has(row.activity_id)) byActivity.set(row.activity_id, []);
      byActivity.get(row.activity_id)?.push(row);
    }
    const climbsByActivity = new Map<string, ConsolidatedClimb[]>();
    for (const climb of climbs) {
      climbsByActivity.set(climb.row.activity_id, [
        ...(climbsByActivity.get(climb.row.activity_id) ?? []),
        climb,
      ]);
    }
    const [coverage] = await executeWithSchema(
      this.#db,
      coverageRowSchema,
      sql`SELECT MIN(${localDate})::text AS first_observed_date
          FROM fitness.v_activity AS a
          LEFT JOIN (${projection}) AS ce ON ce.activity_id = ANY(a.member_activity_ids) AND ce.user_id = a.user_id
          WHERE a.user_id = ${this.#userId}::uuid
            AND ${activityPredicate}
            AND ${providerPredicate}
            AND (${!requiresLog} OR ce.id IS NOT NULL)
            AND ${locationPredicate}
            AND ${gradeSystemPredicate}`,
    );
    const firstObservedDate = coverage?.first_observed_date ?? null;
    const [precedingStreak] = await executeWithSchema(
      this.#db,
      precedingStreakRowSchema,
      sql`WITH climbing_dates AS (
            SELECT DISTINCT ${localDate} AS date
            FROM fitness.v_activity AS a
            LEFT JOIN (${projection}) AS ce ON ce.activity_id = ANY(a.member_activity_ids) AND ce.user_id = a.user_id
              WHERE a.user_id = ${this.#userId}::uuid
              AND ${activityPredicate}
              AND ${localDate} < ${input.startDate}::date
              AND ${providerPredicate}
              AND (${!requiresLog} OR ce.id IS NOT NULL)
                AND ${locationPredicate}
              AND ${gradeSystemPredicate}
          ), numbered AS (
            SELECT date, ROW_NUMBER() OVER (ORDER BY date DESC) AS position
            FROM climbing_dates
          )
          SELECT COUNT(*)::int AS preceding_consecutive_days
          FROM numbered
          WHERE date = ${input.startDate}::date - position::int`,
    );
    const allSummary = attemptSummary(aggregateClimbs);

    const sessionRows = [...byActivity.values()]
      .map((matching) => matching[0])
      .filter((row): row is ClimbingProgressionRow => row !== undefined)
      .sort(
        (left, right) =>
          right.activity_started_at.localeCompare(left.activity_started_at) ||
          right.activity_id.localeCompare(left.activity_id),
      );
    const pageCandidates = cursor
      ? sessionRows.filter(
          (row) =>
            row.activity_started_at < cursor.startedAt ||
            (row.activity_started_at === cursor.startedAt && row.activity_id < cursor.activityId),
        )
      : sessionRows;
    const page = pageCandidates.slice(0, input.limit);
    const hasMore = input.limit < pageCandidates.length;

    const sessions = page.map((activity) => {
      const activityClimbs = climbsByActivity.get(activity.activity_id) ?? [];
      const qualityFlags = unique([
        ...(activity.local_time_source === "unknown" ? ["timezone_assumed_from_user_context"] : []),
        ...(activityClimbs.some((climb) =>
          climb.sourceEntryIds.some((entryId) => possibleDuplicateEntryIds.has(entryId)),
        )
          ? ["possible_overlapping_climbing_entries"]
          : []),
      ]);
      return {
        activity_id: activity.activity_id,
        date: activity.session_date,
        started_at: activity.activity_started_at,
        duration_minutes:
          activity.activity_ended_at == null
            ? null
            : (new Date(activity.activity_ended_at).getTime() -
                new Date(activity.activity_started_at).getTime()) /
              60_000,
        name: activity.activity_name,
        source_providers: activity.source_providers,
        source_external_ids: activity.source_external_ids ?? [],
        member_activity_ids: activity.member_activity_ids,
        timezone: {
          value: activity.timezone,
          start_utc_offset_minutes: activity.start_utc_offset_minutes,
          end_utc_offset_minutes: activity.end_utc_offset_minutes,
          local_time_source: activity.local_time_source,
          analysis_timezone: this.#timezone,
          assumed: activity.local_time_source === "unknown",
        },
        quality_flags: qualityFlags,
        climbing_log_entries: activityClimbs.map((climb) => ({
          id: climb.row.entry_id,
          ...laneFacts(climb.row),
          pitch_id: climb.row.pitch_id,
          pitch_number: climb.row.pitch_number,
          grade: climb.row.grade,
          grade_system: climb.row.grade_system,
          ...normalizedGrade(climb.row, this.#gradePreference),
          sends: climb.row.sends,
          unknown_outcomes: climb.row.unknown_outcomes,
          recorded_attempt_count: climb.row.recorded_attempt_count,
          attempts: climb.row.attempts,
          rock_result_labels: climb.row.rock_result_labels,
          wall_angle_degrees: climb.row.wall_angle_degrees,
          hold_types: climb.row.hold_types,
          climb_name: climb.row.climb_name,
          location_name: climb.row.location_name,
          external_id: climb.row.external_id,
          provenance: {
            value_kind: "measured" as const,
            source_entry_ids: climb.sourceEntryIds,
            source_activity_ids: climb.sourceActivityIds,
            source_providers: climb.sourceProviders,
            source_names: climb.sourceNames,
            source_external_entry_ids: climb.sourceExternalEntryIds,
            merged_duplicate: climb.mergedDuplicate,
          },
        })),
      };
    });

    const dailyClimbs = new Map<string, ConsolidatedClimb[]>();
    const dailyEntryCounts = new Map<string, number>();
    const dailySessions = new Map<string, number>();
    for (const activity of sessionRows) {
      dailySessions.set(activity.session_date, (dailySessions.get(activity.session_date) ?? 0) + 1);
    }
    for (const climb of climbs) {
      dailyEntryCounts.set(
        climb.row.session_date,
        (dailyEntryCounts.get(climb.row.session_date) ?? 0) + 1,
      );
    }
    for (const climb of aggregateClimbs) {
      dailyClimbs.set(climb.row.session_date, [
        ...(dailyClimbs.get(climb.row.session_date) ?? []),
        climb,
      ]);
    }
    let consecutiveDays = precedingStreak?.preceding_consecutive_days ?? 0;
    const exposureDates = new Set(rows.map((row) => row.session_date));
    const daily = datesBetween(input.startDate, input.endDate).map((date) => {
      if (firstObservedDate === null || date < firstObservedDate) {
        consecutiveDays = 0;
        return {
          date,
          exposure_status: "unavailable" as const,
          sessions: null,
          entries: null,
          attempts: null,
          attempts_status: "unavailable" as const,
          sends: null,
          failed_attempts: null,
          observed_outcomes: null,
          unknown_outcomes: null,
          send_rate: null,
          is_rest_day: null,
          consecutive_climbing_days: null,
          rolling_7d_exposure_days: null,
          rolling_28d_exposure_days: null,
        };
      }
      const sessionCount = dailySessions.get(date) ?? 0;
      const matching = dailyClimbs.get(date) ?? [];
      if (sessionCount === 0) consecutiveDays = 0;
      else consecutiveDays += 1;
      const summary = attemptSummary(matching);
      return {
        date,
        exposure_status: sessionCount === 0 ? ("not_observed" as const) : ("observed" as const),
        sessions: sessionCount,
        entries: dailyEntryCounts.get(date) ?? 0,
        attempts: sessionCount === 0 ? 0 : summary.attempts,
        attempts_status: sessionCount === 0 ? ("complete" as const) : summary.attemptsStatus,
        sends: sessionCount === 0 ? 0 : summary.sends,
        failed_attempts: sessionCount === 0 ? 0 : summary.failedAttempts,
        observed_outcomes: sessionCount === 0 ? 0 : summary.observedOutcomes,
        unknown_outcomes: sessionCount === 0 ? 0 : summary.unknownOutcomes,
        send_rate: summary.sendRate,
        is_rest_day: sessionCount === 0,
        consecutive_climbing_days: consecutiveDays,
        rolling_7d_exposure_days: datesBetween(shiftDate(date, -6), date).filter((candidate) =>
          exposureDates.has(candidate),
        ).length,
        rolling_28d_exposure_days: datesBetween(shiftDate(date, -27), date).filter((candidate) =>
          exposureDates.has(candidate),
        ).length,
      };
    });

    const gradedClimbs = aggregateClimbs.filter(hasPublishedGrade);
    const gradedLanes = gradedClimbs.flatMap(splitAttemptLanes);
    const gradeGroups = new Map<string, GradedClimb[]>();
    for (const climb of gradedLanes) {
      const key = JSON.stringify([laneFacts(climb.row), climb.row.grade_system, climb.row.grade]);
      gradeGroups.set(key, [...(gradeGroups.get(key) ?? []), climb]);
    }
    const gradeDistribution = [...gradeGroups.values()]
      .map((matching) => {
        const first = matching[0];
        if (!first) throw new Error("Climbing grade group unexpectedly empty");
        const summary = attemptSummary(matching);
        return {
          ...laneFacts(first.row),
          grade: first.row.grade,
          grade_system: first.row.grade_system,
          ...normalizedGrade(first.row, this.#gradePreference),
          grade_sort_value: gradeSortValue(first.row.grade, first.row.grade_system),
          entries: matching.length,
          attempts: summary.attempts,
          attempts_status: summary.attemptsStatus,
          entries_with_attempts: summary.entriesWithAttempts,
          sends: summary.sends,
          failed_attempts: summary.failedAttempts,
          observed_outcomes: summary.observedOutcomes,
          unknown_outcomes: summary.unknownOutcomes,
          send_rate: summary.sendRate,
          attempts_per_send:
            summary.attemptsStatus === "complete" &&
            summary.unknownOutcomes === 0 &&
            summary.sends != null &&
            summary.sends > 0 &&
            summary.attempts != null
              ? summary.attempts / summary.sends
              : null,
        };
      })
      .sort(
        (left, right) =>
          (left.grade_sort_value ?? Number.MAX_SAFE_INTEGER) -
            (right.grade_sort_value ?? Number.MAX_SAFE_INTEGER) ||
          left.grade.localeCompare(right.grade),
      );

    const progressionByDateAndLane = new Map<string, GradedClimb>();
    for (const climb of gradedLanes.filter((candidate) => candidate.row.sends > 0)) {
      const key = JSON.stringify([
        climb.row.session_date,
        laneFacts(climb.row),
        climb.row.grade_system,
      ]);
      const current = progressionByDateAndLane.get(key);
      const candidateSort = gradeSortValue(climb.row.grade, climb.row.grade_system);
      const currentSort = current
        ? gradeSortValue(current.row.grade, current.row.grade_system)
        : null;
      if (candidateSort !== null && (currentSort === null || candidateSort > currentSort)) {
        progressionByDateAndLane.set(key, climb);
      }
    }
    const gradeProgression = [...progressionByDateAndLane.values()]
      .sort(
        (left, right) =>
          left.row.session_date.localeCompare(right.row.session_date) ||
          JSON.stringify(laneFacts(left.row)).localeCompare(JSON.stringify(laneFacts(right.row))),
      )
      .map((climb) => ({
        date: climb.row.session_date,
        ...laneFacts(climb.row),
        grade: climb.row.grade,
        grade_system: climb.row.grade_system,
        ...normalizedGrade(climb.row, this.#gradePreference),
        grade_sort_value: gradeSortValue(climb.row.grade, climb.row.grade_system),
        activity_id: climb.row.activity_id,
        entry_id: climb.row.entry_id,
        source_providers: climb.sourceProviders,
      }));

    const hardestSend = hardestEvidence(gradedLanes);
    const belowHardest = hardestSend
      ? gradedClimbs.filter((climb) => {
          const sort = gradeSortValue(climb.row.grade, climb.row.grade_system);
          return sort !== null && sort < hardestSend.sort;
        })
      : [];
    const belowSummary = attemptSummary(belowHardest);
    const lastPageRow = page.at(-1) ?? null;

    return {
      range: { start_date: input.startDate, end_date: input.endDate, timezone: this.#timezone },
      definitions: {
        attempts:
          "Attempt totals count recorded rows at the selected scope. These totals do not imply complete lifetime attempt history.",
        send_rate:
          "Confirmed free-rock sends divided by recorded attempts with a known free-send result. Unknown execution facts remain outside this denominator.",
        rolling_exposure:
          "Count of calendar days containing at least one canonical climbing session in the trailing 7 or 28 days, inclusive.",
        duplicate_handling:
          "Canonical activity groups count once. Exact matching entries from different member activities/providers are consolidated; conflicting identity matches remain in session detail, are flagged, and are excluded from aggregates.",
        volume_below_range_hardest_send:
          "Known attempts on entries graded below the hardest observed send in this requested range; this is a descriptive relative-volume measure, not physiological intensity.",
      },
      coverage: {
        sessions: sessionRows.length,
        entries: climbs.length,
        entries_with_attempts: allSummary.entriesWithAttempts,
        observed_free_send_outcomes: allSummary.observedOutcomes,
        unknown_free_send_outcomes: allSummary.unknownOutcomes,
        attempt_data: allSummary.attemptsStatus,
        first_observed_date: firstObservedDate,
        timezone_assumed_sessions: sessionRows.filter(
          (activity) => activity.local_time_source === "unknown",
        ).length,
        merged_exact_duplicate_records: mergedRecords,
        possible_duplicate_groups: requestedPossibleDuplicateGroups.length,
        entries_excluded_from_aggregates: climbs.length - aggregateClimbs.length,
      },
      daily,
      grade_distribution: gradeDistribution,
      grade_progression: gradeProgression,
      hardest: {
        send: hardestOutput(hardestSend, this.#gradePreference),
        flash: hardestOutput(hardestEvidence(gradedLanes, "flash"), this.#gradePreference),
        onsight: hardestOutput(hardestEvidence(gradedLanes, "onsight"), this.#gradePreference),
      },
      below_range_hardest_send: {
        metric_name: "volume_below_range_hardest_send",
        entries: belowSummary.entriesWithAttempts,
        attempts: belowSummary.attempts,
        status: belowSummary.attemptsStatus,
      },
      sessions,
      pagination: {
        limit: input.limit,
        has_more: hasMore,
        next_cursor: hasMore && lastPageRow ? encodeCursor(lastPageRow, this.#userId, shape) : null,
      },
    };
  }
}
