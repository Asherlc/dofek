import { createHash } from "node:crypto";
import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { dateStringSchema, executeWithSchema, timestampStringSchema } from "../lib/typed-sql.ts";

const sourceExternalIdSchema = z.object({
  providerId: z.string(),
  externalId: z.string(),
  memberActivityId: z.string().optional(),
  subsource: z.string().nullable().optional(),
});

const rowSchema = z.object({
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
  set_id: z.string().uuid(),
  set_activity_id: z.string().uuid(),
  set_provider: z.string(),
  exercise_id: z.string().uuid(),
  exercise_name: z.string(),
  equipment: z.string().nullable(),
  muscle_groups: z.array(z.string()).nullable(),
  exercise_type: z.string().nullable(),
  movement: z.string().nullable(),
  exercise_index: z.coerce.number().int(),
  set_index: z.coerce.number().int(),
  set_type: z.string().nullable(),
  weight_kg: z.coerce.number().nullable(),
  reps: z.coerce.number().int().nullable(),
  distance_meters: z.coerce.number().nullable(),
  duration_seconds: z.coerce.number().int().nullable(),
  rpe: z.coerce.number().nullable(),
  notes: z.string().nullable(),
  raw: z.record(z.string(), z.unknown()),
});

const coverageRowSchema = z.object({ first_observed_date: dateStringSchema.nullable() });
const cursorSchema = z
  .object({
    version: z.literal(1),
    userId: z.string().uuid(),
    shape: z.string().min(1),
    startedAt: z.string().datetime({ offset: true }),
    activityId: z.string().uuid(),
  })
  .strict();

type Row = z.infer<typeof rowSchema>;

export interface StrengthProgressionInput {
  startDate: string;
  endDate: string;
  providers: string[];
  exerciseIds: string[];
  cursor: string | null;
  limit: number;
}

interface ConsolidatedSet {
  row: Row;
  sourceRows: Row[];
  conflicting: boolean;
  duplicateSameSourceIdentity: boolean;
  ambiguousCrossProviderExerciseOccurrence: boolean;
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function round(value: number, precision = 2): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

function sourceExerciseIdentity(raw: Record<string, unknown>) {
  const providerExerciseId =
    typeof raw.providerExerciseId === "string" ? raw.providerExerciseId : null;
  const providerExerciseName =
    typeof raw.providerExerciseName === "string"
      ? raw.providerExerciseName
      : typeof raw.exerciseName === "string"
        ? raw.exerciseName
        : null;
  return {
    provider_exercise_id: providerExerciseId,
    provider_exercise_name: providerExerciseName,
    status:
      providerExerciseId !== null || providerExerciseName !== null
        ? ("available" as const)
        : ("unavailable" as const),
  };
}

function normalizedFingerprint(row: Row): string {
  return JSON.stringify([
    row.set_type,
    row.weight_kg,
    row.reps,
    row.distance_meters,
    row.duration_seconds,
    row.rpe,
    row.notes,
  ]);
}

function activityExerciseFingerprint(row: Row): string {
  return JSON.stringify([row.activity_id, row.exercise_id]);
}

function identityFingerprint(row: Row, sourceLocalOccurrenceGroups: Set<string>): string {
  const activityExercise = activityExerciseFingerprint(row);
  return sourceLocalOccurrenceGroups.has(activityExercise)
    ? JSON.stringify([
        row.activity_id,
        row.exercise_id,
        row.set_activity_id,
        row.exercise_index,
        row.set_index,
      ])
    : JSON.stringify([row.activity_id, row.exercise_id, row.set_index]);
}

function consolidateSets(rows: Row[]) {
  const occurrencesByActivityExercise = new Map<string, Map<string, Set<number>>>();
  const sourcesByActivityExercise = new Map<string, Set<string>>();
  for (const row of rows) {
    const activityExercise = activityExerciseFingerprint(row);
    const occurrenceBySource = occurrencesByActivityExercise.get(activityExercise) ?? new Map();
    const sourceOccurrences = occurrenceBySource.get(row.set_activity_id) ?? new Set();
    sourceOccurrences.add(row.exercise_index);
    occurrenceBySource.set(row.set_activity_id, sourceOccurrences);
    occurrencesByActivityExercise.set(activityExercise, occurrenceBySource);
    const sources = sourcesByActivityExercise.get(activityExercise) ?? new Set();
    sources.add(`${row.set_activity_id}:${row.set_provider}`);
    sourcesByActivityExercise.set(activityExercise, sources);
  }
  const sourceLocalOccurrenceGroups = new Set(
    [...occurrencesByActivityExercise.entries()]
      .filter(([, bySource]) => [...bySource.values()].some((occurrences) => occurrences.size > 1))
      .map(([activityExercise]) => activityExercise),
  );
  const ambiguousCrossProviderOccurrenceGroups = new Set(
    [...sourceLocalOccurrenceGroups].filter(
      (activityExercise) => (sourcesByActivityExercise.get(activityExercise)?.size ?? 0) > 1,
    ),
  );
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const identity = identityFingerprint(row, sourceLocalOccurrenceGroups);
    groups.set(identity, [...(groups.get(identity) ?? []), row]);
  }

  const sets: ConsolidatedSet[] = [];
  let mergedExactDuplicateRecords = 0;
  let possibleDuplicateGroups = ambiguousCrossProviderOccurrenceGroups.size;
  for (const group of groups.values()) {
    const identitySets: ConsolidatedSet[] = [];
    for (const row of group) {
      const fingerprint = normalizedFingerprint(row);
      const duplicate = identitySets.find(
        (candidate) =>
          normalizedFingerprint(candidate.row) === fingerprint &&
          candidate.sourceRows.every(
            (sourceRow) => sourceRow.set_activity_id !== row.set_activity_id,
          ),
      );
      if (duplicate) {
        duplicate.sourceRows.push(row);
        mergedExactDuplicateRecords += 1;
      } else {
        identitySets.push({
          row,
          sourceRows: [row],
          conflicting: false,
          duplicateSameSourceIdentity: false,
          ambiguousCrossProviderExerciseOccurrence: ambiguousCrossProviderOccurrenceGroups.has(
            activityExerciseFingerprint(row),
          ),
        });
      }
    }

    let hasCrossProviderConflict = false;
    for (const candidate of identitySets) {
      candidate.duplicateSameSourceIdentity = identitySets.some(
        (other) =>
          other !== candidate &&
          candidate.sourceRows.some((candidateSource) =>
            other.sourceRows.some(
              (otherSource) => candidateSource.set_activity_id === otherSource.set_activity_id,
            ),
          ),
      );
      candidate.conflicting = identitySets.some(
        (other) =>
          other !== candidate &&
          normalizedFingerprint(other.row) !== normalizedFingerprint(candidate.row) &&
          candidate.sourceRows.some((candidateSource) =>
            other.sourceRows.some(
              (otherSource) => candidateSource.set_activity_id !== otherSource.set_activity_id,
            ),
          ),
      );
      hasCrossProviderConflict ||= candidate.conflicting;
    }
    if (hasCrossProviderConflict) possibleDuplicateGroups += 1;
    sets.push(...identitySets);
  }
  return { sets, mergedExactDuplicateRecords, possibleDuplicateGroups };
}

function isWarmup(row: Row): boolean {
  return row.set_type === "warmup";
}

function isWorking(row: Row): boolean {
  return row.set_type === "working" || row.set_type === "dropset" || row.set_type === "failure";
}

function qualityFlags(row: Row): string[] {
  const flags: string[] = [];
  const loadBearingCandidate = row.set_type !== "warmup" && row.set_type !== "rest";
  if (row.set_type === null) flags.push("missing_set_type");
  if (loadBearingCandidate && row.reps !== null && row.reps <= 0) {
    flags.push("non_positive_repetitions");
  }
  if (row.reps !== null && row.reps > 100) flags.push("implausible_repetitions");
  if (loadBearingCandidate && row.weight_kg !== null && row.weight_kg <= 0) {
    flags.push("non_positive_weight");
  }
  if (row.weight_kg !== null && row.weight_kg > 500) flags.push("implausible_weight");
  if (row.rpe !== null && (row.rpe < 0 || row.rpe > 10)) flags.push("rpe_out_of_range");
  if (
    row.reps !== null &&
    row.reps > 100 &&
    row.weight_kg !== null &&
    row.weight_kg >= 1 &&
    row.weight_kg <= 100
  ) {
    flags.push("possible_reversed_fields_or_import_corruption");
  }
  return flags;
}

function volumeResult(set: ConsolidatedSet, flags: string[]) {
  if (set.conflicting || flags.length > 0) {
    return { status: "unavailable" as const, value_kg_reps: null, reason: "quality_flags" };
  }
  if (!isWorking(set.row)) {
    return { status: "unavailable" as const, value_kg_reps: null, reason: "non_working_set" };
  }
  if (set.row.weight_kg === null || set.row.reps === null) {
    return { status: "unavailable" as const, value_kg_reps: null, reason: "missing_load_or_reps" };
  }
  return {
    status: "available" as const,
    value_kg_reps: round(set.row.weight_kg * set.row.reps, 3),
    reason: null,
  };
}

function estimatedOneRepMaxResult(set: ConsolidatedSet, flags: string[]) {
  if (set.conflicting || flags.length > 0) {
    return {
      status: "unavailable" as const,
      value_kg: null,
      formula: "Epley" as const,
      reason: "quality_flags",
    };
  }
  if (!isWorking(set.row)) {
    return {
      status: "unavailable" as const,
      value_kg: null,
      formula: "Epley" as const,
      reason: "non_working_set",
    };
  }
  if (set.row.weight_kg === null || set.row.reps === null) {
    return {
      status: "unavailable" as const,
      value_kg: null,
      formula: "Epley" as const,
      reason: "missing_load_or_reps",
    };
  }
  if (set.row.reps < 1 || set.row.reps > 12 || set.row.weight_kg <= 0) {
    return {
      status: "unavailable" as const,
      value_kg: null,
      formula: "Epley" as const,
      reason: "outside_formula_range_1_to_12_reps",
    };
  }
  return {
    status: "available" as const,
    value_kg: round(set.row.weight_kg * (1 + set.row.reps / 30)),
    formula: "Epley" as const,
    reason: null,
  };
}

function cursorShape(input: StrengthProgressionInput, timezone: string): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        startDate: input.startDate,
        endDate: input.endDate,
        providers: [...input.providers].sort(),
        exerciseIds: [...input.exerciseIds].sort(),
        timezone,
      }),
    )
    .digest("base64url");
}

function decodeCursor(cursor: string | null, userId: string, shape: string) {
  if (cursor === null) return null;
  try {
    const parsed = cursorSchema.parse(
      JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")),
    );
    if (parsed.userId !== userId || parsed.shape !== shape) throw new Error("cursor mismatch");
    return parsed;
  } catch {
    throw new Error("Invalid strength progression cursor");
  }
}

function encodeCursor(row: Row, userId: string, shape: string): string {
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

/** Exact-range, anomaly-safe strength progression over canonical activity groups. */
export class StrengthProgressionRepository {
  readonly #db: Pick<Database, "execute">;
  readonly #userId: string;
  readonly #timezone: string;

  constructor(db: Pick<Database, "execute">, userId: string, timezone: string) {
    this.#db = db;
    this.#userId = userId;
    this.#timezone = timezone;
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

  async listRange(input: StrengthProgressionInput) {
    const localDate = this.#localDateSql();
    const providerPredicate =
      input.providers.length === 0
        ? sql`true`
        : sql`(
            source_activity.provider_id IN (${sql.join(
              input.providers.map((provider) => sql`${provider}`),
              sql`, `,
            )})
            OR a.source_providers && ARRAY[${sql.join(
              input.providers.map((provider) => sql`${provider}`),
              sql`, `,
            )}]::text[]
          )`;
    const exercisePredicate =
      input.exerciseIds.length === 0
        ? sql`true`
        : sql`strength.exercise_id IN (${sql.join(
            input.exerciseIds.map((exerciseId) => sql`${exerciseId}::uuid`),
            sql`, `,
          )})`;
    const rows = await executeWithSchema(
      this.#db,
      rowSchema,
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
            strength.id::text AS set_id,
            strength.activity_id::text AS set_activity_id,
            source_activity.provider_id AS set_provider,
            exercise.id::text AS exercise_id,
            exercise.name AS exercise_name,
            exercise.equipment,
            exercise.muscle_groups,
            exercise.exercise_type,
            exercise.movement,
            strength.exercise_index,
            strength.set_index,
            strength.set_type,
            strength.weight_kg,
            strength.reps,
            strength.distance_meters,
            strength.duration_seconds,
            strength.rpe,
            strength.notes,
            strength.raw
          FROM fitness.v_activity AS a
          JOIN fitness.strength_set AS strength
            ON strength.activity_id = ANY(a.member_activity_ids)
          JOIN fitness.activity AS source_activity ON source_activity.id = strength.activity_id
          JOIN fitness.exercise AS exercise ON exercise.id = strength.exercise_id
          WHERE a.user_id = ${this.#userId}::uuid
            AND ${localDate} BETWEEN ${input.startDate}::date AND ${input.endDate}::date
            AND ${providerPredicate}
            AND ${exercisePredicate}
          ORDER BY a.started_at DESC, a.id, strength.exercise_index, strength.set_index,
            strength.created_at, strength.id`,
    );

    const priorRows = await executeWithSchema(
      this.#db,
      rowSchema,
      sql`/* strength_progression_prior */
          SELECT
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
            strength.id::text AS set_id,
            strength.activity_id::text AS set_activity_id,
            source_activity.provider_id AS set_provider,
            exercise.id::text AS exercise_id,
            exercise.name AS exercise_name,
            exercise.equipment,
            exercise.muscle_groups,
            exercise.exercise_type,
            exercise.movement,
            strength.exercise_index,
            strength.set_index,
            strength.set_type,
            strength.weight_kg,
            strength.reps,
            strength.distance_meters,
            strength.duration_seconds,
            strength.rpe,
            strength.notes,
            strength.raw
          FROM fitness.v_activity AS a
          JOIN fitness.strength_set AS strength
            ON strength.activity_id = ANY(a.member_activity_ids)
          JOIN fitness.activity AS source_activity ON source_activity.id = strength.activity_id
          JOIN fitness.exercise AS exercise ON exercise.id = strength.exercise_id
          WHERE a.user_id = ${this.#userId}::uuid
            AND ${localDate} < ${input.startDate}::date
            AND ${providerPredicate}
            AND ${exercisePredicate}
          ORDER BY a.started_at, a.id, strength.exercise_index, strength.set_index,
            strength.created_at, strength.id`,
    );

    const [coverage] = await executeWithSchema(
      this.#db,
      coverageRowSchema,
      sql`SELECT MIN(${localDate})::text AS first_observed_date
          FROM fitness.v_activity AS a
          JOIN fitness.strength_set AS strength
            ON strength.activity_id = ANY(a.member_activity_ids)
          JOIN fitness.activity AS source_activity ON source_activity.id = strength.activity_id
          WHERE a.user_id = ${this.#userId}::uuid
            AND ${providerPredicate}
            AND ${exercisePredicate}`,
    );

    const { sets, mergedExactDuplicateRecords, possibleDuplicateGroups } = consolidateSets(rows);
    const priorBestByExercise = new Map<
      string,
      {
        date: string;
        value_kg: number;
        set_id: string;
        activity_id: string;
        weight_kg: number | null;
        reps: number | null;
      }
    >();
    for (const set of consolidateSets(priorRows).sets) {
      const flags = [
        ...qualityFlags(set.row),
        ...(set.duplicateSameSourceIdentity ? ["duplicate_same_source_set_identity"] : []),
        ...(set.ambiguousCrossProviderExerciseOccurrence
          ? ["ambiguous_cross_provider_exercise_occurrence"]
          : []),
        ...(set.conflicting ? ["possible_overlapping_conflicting_set"] : []),
      ];
      const estimate = estimatedOneRepMaxResult(set, flags).value_kg;
      if (estimate === null) continue;
      const evidence = {
        date: set.row.session_date,
        value_kg: estimate,
        set_id: set.row.set_id,
        activity_id: set.row.activity_id,
        weight_kg: set.row.weight_kg,
        reps: set.row.reps,
      };
      const priorBest = priorBestByExercise.get(set.row.exercise_id);
      if (priorBest === undefined || estimate > priorBest.value_kg) {
        priorBestByExercise.set(set.row.exercise_id, evidence);
      }
    }
    const evaluatedSets = sets.map((set) => {
      const flags = [
        ...qualityFlags(set.row),
        ...(set.duplicateSameSourceIdentity ? ["duplicate_same_source_set_identity"] : []),
        ...(set.ambiguousCrossProviderExerciseOccurrence
          ? ["ambiguous_cross_provider_exercise_occurrence"]
          : []),
        ...(set.conflicting ? ["possible_overlapping_conflicting_set"] : []),
      ];
      return {
        set,
        flags,
        volume: volumeResult(set, flags),
        estimatedOneRepMax: estimatedOneRepMaxResult(set, flags),
      };
    });

    const sessionRows = [...new Map(rows.map((row) => [row.activity_id, row])).values()];
    const shape = cursorShape(input, this.#timezone);
    const cursor = decodeCursor(input.cursor, this.#userId, shape);
    const filteredSessionRows = cursor
      ? sessionRows.filter(
          (row) =>
            row.activity_started_at < cursor.startedAt ||
            (row.activity_started_at === cursor.startedAt && row.activity_id > cursor.activityId),
        )
      : sessionRows;
    const hasMore = filteredSessionRows.length > input.limit;
    const pageRows = filteredSessionRows.slice(0, input.limit);
    const pageActivityIds = new Set(pageRows.map((row) => row.activity_id));

    const setOutput = (evaluated: (typeof evaluatedSets)[number]) => {
      const { set, flags, volume, estimatedOneRepMax } = evaluated;
      const originalRecords = set.sourceRows.map((sourceRow) => ({
        provider: sourceRow.set_provider,
        activity_id: sourceRow.set_activity_id,
        set_id: sourceRow.set_id,
        values: sourceRow.raw,
        source_exercise_identity: sourceExerciseIdentity(sourceRow.raw),
      }));
      const firstOriginal = originalRecords.find((record) => Object.keys(record.values).length > 0);
      return {
        id: set.row.set_id,
        exercise_index: set.row.exercise_index,
        set_index: set.row.set_index,
        set_type: set.row.set_type,
        is_warmup: isWarmup(set.row),
        is_working_set: isWorking(set.row),
        normalized: {
          weight_kg: set.row.weight_kg,
          reps: set.row.reps,
          rpe: set.row.rpe,
          rir: null,
          rir_status: "not_recorded_by_canonical_schema" as const,
          distance_meters: set.row.distance_meters,
          duration_seconds: set.row.duration_seconds,
          notes: set.row.notes,
        },
        original: {
          status: firstOriginal ? ("available" as const) : ("unavailable" as const),
          values: firstOriginal?.values ?? null,
          reason: firstOriginal ? null : "not_recorded_for_legacy_strength_set",
          records: originalRecords,
        },
        volume,
        estimated_one_rep_max: estimatedOneRepMax,
        quality_flags: flags,
        excluded_from_aggregates: flags.length > 0,
        provenance: {
          value_kind: "mixed" as const,
          source_set_ids: unique(set.sourceRows.map((row) => row.set_id)),
          source_activity_ids: unique(set.sourceRows.map((row) => row.set_activity_id)),
          source_providers: unique(set.sourceRows.map((row) => row.set_provider)),
          merged_duplicate: set.sourceRows.length > 1,
          calculated_fields: ["volume_kg_reps", "estimated_one_rep_max"],
        },
      };
    };

    const sessionOutputs = pageRows.map((row) => {
      const sessionSets = evaluatedSets.filter(
        (evaluated) => evaluated.set.row.activity_id === row.activity_id,
      );
      const groupedExercises = new Map<string, typeof sessionSets>();
      for (const set of sessionSets) {
        groupedExercises.set(set.set.row.exercise_id, [
          ...(groupedExercises.get(set.set.row.exercise_id) ?? []),
          set,
        ]);
      }
      return {
        activity_id: row.activity_id,
        date: row.session_date,
        started_at: row.activity_started_at,
        duration_minutes:
          row.activity_ended_at === null
            ? null
            : round(
                (new Date(row.activity_ended_at).getTime() -
                  new Date(row.activity_started_at).getTime()) /
                  60_000,
              ),
        name: row.activity_name,
        source_providers: row.source_providers,
        source_external_ids: row.source_external_ids ?? [],
        member_activity_ids: row.member_activity_ids,
        timezone: {
          value: row.timezone,
          start_utc_offset_minutes: row.start_utc_offset_minutes,
          end_utc_offset_minutes: row.end_utc_offset_minutes,
          local_time_source: row.local_time_source,
          analysis_timezone: this.#timezone,
          assumed: row.local_time_source === "unknown",
        },
        quality_flags: [
          ...(row.local_time_source === "unknown" ? ["timezone_assumed_from_user_context"] : []),
          ...(sessionSets.some((set) => set.flags.length > 0)
            ? ["contains_suspicious_strength_records"]
            : []),
        ],
        exercises: [...groupedExercises.values()].map((exerciseSets) => {
          const exerciseRow = exerciseSets[0]?.set.row;
          if (!exerciseRow) throw new Error("Strength exercise group cannot be empty");
          return {
            exercise_id: exerciseRow.exercise_id,
            name: exerciseRow.exercise_name,
            equipment: exerciseRow.equipment,
            muscle_groups: exerciseRow.muscle_groups ?? [],
            exercise_type: exerciseRow.exercise_type,
            movement: exerciseRow.movement,
            normalized_identity: true,
            sets: exerciseSets.map(setOutput),
          };
        }),
      };
    });

    const groupedByExercise = new Map<string, typeof evaluatedSets>();
    for (const evaluated of evaluatedSets) {
      groupedByExercise.set(evaluated.set.row.exercise_id, [
        ...(groupedByExercise.get(evaluated.set.row.exercise_id) ?? []),
        evaluated,
      ]);
    }
    const exercises = [...groupedByExercise.values()]
      .map((exerciseSets) => {
        const firstSet = exerciseSets[0];
        if (!firstSet) throw new Error("Strength exercise group cannot be empty");
        const validVolumes = exerciseSets.flatMap((set) =>
          set.volume.value_kg_reps === null ? [] : [set.volume.value_kg_reps],
        );
        const validEstimates = exerciseSets
          .flatMap((set) =>
            set.estimatedOneRepMax.value_kg === null
              ? []
              : [
                  {
                    date: set.set.row.session_date,
                    value_kg: set.estimatedOneRepMax.value_kg,
                    set_id: set.set.row.set_id,
                    activity_id: set.set.row.activity_id,
                    weight_kg: set.set.row.weight_kg,
                    reps: set.set.row.reps,
                  },
                ],
          )
          .sort((a, b) => a.date.localeCompare(b.date) || a.set_id.localeCompare(b.set_id));
        const dailyBestEstimates = new Map<string, (typeof validEstimates)[number]>();
        for (const estimate of validEstimates) {
          const current = dailyBestEstimates.get(estimate.date);
          if (!current || estimate.value_kg > current.value_kg) {
            dailyBestEstimates.set(estimate.date, estimate);
          }
        }
        const observations = [...dailyBestEstimates.values()].sort((a, b) =>
          a.date.localeCompare(b.date),
        );
        let priorBest = priorBestByExercise.get(firstSet.set.row.exercise_id) ?? null;
        const prs = observations.flatMap((observation) => {
          if (priorBest !== null && observation.value_kg <= priorBest.value_kg) return [];
          const result = {
            ...observation,
            previous_best_kg: priorBest?.value_kg ?? null,
            previous_best_evidence: priorBest,
          };
          priorBest = observation;
          return [result];
        });
        const firstEstimate = observations[0]?.value_kg ?? null;
        const latestEstimate = observations.at(-1)?.value_kg ?? null;
        const dates = unique(exerciseSets.map((set) => set.set.row.session_date));
        const activities = unique(exerciseSets.map((set) => set.set.row.activity_id));
        const daily = dates.map((date) => {
          const dateSets = exerciseSets.filter((set) => set.set.row.session_date === date);
          const dateVolumes = dateSets.flatMap((set) =>
            set.volume.value_kg_reps === null ? [] : [set.volume.value_kg_reps],
          );
          const dateEstimates = dateSets.flatMap((set) =>
            set.estimatedOneRepMax.value_kg === null ? [] : [set.estimatedOneRepMax.value_kg],
          );
          const dateWeights = dateSets.flatMap((set) =>
            set.flags.length === 0 &&
            isWorking(set.set.row) &&
            set.set.row.weight_kg !== null &&
            set.set.row.weight_kg > 0
              ? [set.set.row.weight_kg]
              : [],
          );
          return {
            date,
            sessions: unique(dateSets.map((set) => set.set.row.activity_id)).length,
            working_sets: dateSets.filter((set) => isWorking(set.set.row)).length,
            valid_working_sets: dateSets.filter((set) => set.volume.status === "available").length,
            total_volume_kg_reps: round(
              dateVolumes.reduce((sum, value) => sum + value, 0),
              3,
            ),
            max_weight_kg: dateWeights.length === 0 ? null : Math.max(...dateWeights),
            best_estimated_one_rep_max_kg:
              dateEstimates.length === 0 ? null : Math.max(...dateEstimates),
          };
        });
        return {
          exercise_id: firstSet.set.row.exercise_id,
          name: firstSet.set.row.exercise_name,
          equipment: firstSet.set.row.equipment,
          muscle_groups: firstSet.set.row.muscle_groups ?? [],
          exercise_type: firstSet.set.row.exercise_type,
          movement: firstSet.set.row.movement,
          normalized_identity: true,
          frequency_days: dates.length,
          frequency_sessions: activities.length,
          working_sets: exerciseSets.filter((set) => isWorking(set.set.row)).length,
          valid_working_sets: exerciseSets.filter((set) => set.volume.status === "available")
            .length,
          total_volume_kg_reps: round(
            validVolumes.reduce((sum, value) => sum + value, 0),
            3,
          ),
          estimated_one_rep_max: {
            formula: "Epley" as const,
            first_kg: firstEstimate,
            latest_kg: latestEstimate,
            best_kg:
              observations.length === 0
                ? null
                : Math.max(...observations.map((observation) => observation.value_kg)),
            change_kg:
              firstEstimate === null || latestEstimate === null
                ? null
                : round(latestEstimate - firstEstimate),
            change_percent:
              firstEstimate === null || latestEstimate === null || firstEstimate === 0
                ? null
                : round(((latestEstimate - firstEstimate) / firstEstimate) * 100),
            observations,
          },
          daily,
          prs,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name) || a.exercise_id.localeCompare(b.exercise_id));

    const validVolumes = evaluatedSets.flatMap((set) =>
      set.volume.value_kg_reps === null ? [] : [set.volume.value_kg_reps],
    );
    const lastPageRow = pageRows.at(-1);
    return {
      range: { start_date: input.startDate, end_date: input.endDate, timezone: this.#timezone },
      channel: {
        id: "strength" as const,
        interchangeable_with: [],
        note: "Strength load remains separate from cardiovascular, climbing, and finger-loading channels.",
      },
      definitions: {
        estimated_one_rep_max:
          "Epley estimate = weight_kg × (1 + repetitions / 30), calculated only for unflagged working sets of 1–12 repetitions.",
        volume:
          "Set volume = normalized weight_kg × repetitions; warm-ups, rests, missing values, and quality-flagged records are excluded.",
        working_set:
          "Working sets include working, dropset, and failure set types; warmup and rest types are excluded.",
        anomaly_handling:
          "Original and normalized values are returned unchanged. Flagged records remain visible but are excluded from volume, e1RM, trends, and PRs.",
        duplicate_handling:
          "Exact duplicates across distinct canonical member activities are merged only when exercise occurrence alignment is unambiguous. Repeated source-local identities and ambiguous/conflicting overlaps remain visible and are excluded from aggregates.",
        personal_records:
          "An in-range e1RM is a PR only when it exceeds the anomaly-safe best before the range and every earlier valid in-range estimate; preceding-best evidence is returned.",
      },
      coverage: {
        sessions: sessionRows.length,
        source_sets: rows.length,
        sets: evaluatedSets.length,
        first_observed_date: coverage?.first_observed_date ?? null,
        timezone_assumed_sessions: sessionRows.filter((row) => row.local_time_source === "unknown")
          .length,
        merged_exact_duplicate_records: mergedExactDuplicateRecords,
        possible_duplicate_groups: possibleDuplicateGroups,
        flagged_sets: evaluatedSets.filter((set) => set.flags.length > 0).length,
        sets_excluded_from_volume: evaluatedSets.filter(
          (set) => set.volume.status === "unavailable",
        ).length,
        sets_excluded_from_estimated_one_rep_max: evaluatedSets.filter(
          (set) => set.estimatedOneRepMax.status === "unavailable",
        ).length,
      },
      summary: {
        sessions: sessionRows.length,
        exercises: exercises.length,
        frequency_days: unique(sessionRows.map((row) => row.session_date)).length,
        valid_working_sets: evaluatedSets.filter((set) => set.volume.status === "available").length,
        total_volume_kg_reps: round(
          validVolumes.reduce((sum, value) => sum + value, 0),
          3,
        ),
      },
      exercises,
      sessions: sessionOutputs.filter((session) => pageActivityIds.has(session.activity_id)),
      pagination: {
        limit: input.limit,
        has_more: hasMore,
        next_cursor: hasMore && lastPageRow ? encodeCursor(lastPageRow, this.#userId, shape) : null,
      },
    };
  }
}
