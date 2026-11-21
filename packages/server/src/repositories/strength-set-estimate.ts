import { parseStrongExerciseName, STRONG_PROVIDER_ID } from "dofek/providers/strong-csv";
import { z } from "zod";

export const strengthSetRowSchema = z.object({
  activity_id: z.string().uuid(),
  set_id: z.string().uuid(),
  set_activity_id: z.string().uuid(),
  set_provider: z.string(),
  exercise_id: z.string().uuid(),
  exercise_name: z.string(),
  equipment: z.string().nullable(),
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

type StrengthSetRow = z.infer<typeof strengthSetRowSchema>;

export interface ConsolidatedSet<Row extends StrengthSetRow> {
  row: Row;
  sourceRows: Row[];
  conflicting: boolean;
  duplicateSameSourceIdentity: boolean;
  ambiguousCrossProviderExerciseOccurrence: boolean;
}

function normalizedFingerprint(row: StrengthSetRow): string {
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

function activityExerciseFingerprint(row: StrengthSetRow): string {
  return JSON.stringify([row.activity_id, row.exercise_id]);
}

function identityFingerprint(
  row: StrengthSetRow,
  sourceLocalOccurrenceGroups: Set<string>,
): string {
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

export function consolidateSets<Row extends StrengthSetRow>(rows: Row[]) {
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

  const sets: ConsolidatedSet<Row>[] = [];
  let mergedExactDuplicateRecords = 0;
  let possibleDuplicateGroups = ambiguousCrossProviderOccurrenceGroups.size;
  for (const group of groups.values()) {
    const identitySets: ConsolidatedSet<Row>[] = [];
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

export function isWorking(row: Pick<StrengthSetRow, "set_type">): boolean {
  return row.set_type === "working" || row.set_type === "dropset" || row.set_type === "failure";
}

function qualityFlags(row: StrengthSetRow): string[] {
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

export function consolidatedStrengthQualityFlags(set: ConsolidatedSet<StrengthSetRow>): string[] {
  return [
    ...qualityFlags(set.row),
    ...(set.duplicateSameSourceIdentity ? ["duplicate_same_source_set_identity"] : []),
    ...(set.ambiguousCrossProviderExerciseOccurrence
      ? ["ambiguous_cross_provider_exercise_occurrence"]
      : []),
    ...(set.conflicting ? ["possible_overlapping_conflicting_set"] : []),
  ];
}

const supportedExercises = new Set(["bench press", "squat", "back squat", "deadlift"]);

function normalizeExercise(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

type StrengthEstimateRow = Pick<
  StrengthSetRow,
  "set_provider" | "exercise_name" | "equipment" | "set_type" | "weight_kg" | "reps" | "raw"
>;

export function estimateStrengthSet(row: StrengthEstimateRow) {
  const { raw, weight_kg: weight, reps } = row;
  if (row.set_provider !== STRONG_PROVIDER_ID || raw.setTag !== "Failure") {
    return { value: null, reason: "fatigue_unknown" } as const;
  }
  if (row.set_type !== "working" && row.set_type !== "failure")
    return { value: null, reason: "non_working_set" } as const;
  if (weight === null || !Number.isFinite(weight) || weight <= 0 || reps === null) {
    return { value: null, reason: "missing_or_invalid_load_or_reps" } as const;
  }
  if (!Number.isInteger(reps) || reps < 2 || reps > 10) {
    return { value: null, reason: "outside_formula_range_2_to_10_reps" } as const;
  }
  const source =
    typeof raw.exerciseName === "string" ? parseStrongExerciseName(raw.exerciseName) : null;
  const name = normalizeExercise(row.exercise_name);
  if (
    !supportedExercises.has(name) ||
    row.equipment?.trim().toLowerCase() !== "barbell" ||
    source?.equipment?.trim().toLowerCase() !== "barbell" ||
    normalizeExercise(source.exerciseName) !== name ||
    (raw.providerExerciseName !== undefined && raw.providerExerciseName !== raw.exerciseName)
  ) {
    return { value: null, reason: "unsupported_or_conflicting_exercise_identity" } as const;
  }
  const unit = raw.reportedWeightUnit;
  if ((unit !== "kg" && unit !== "lbs") || raw.weightUnit !== unit) {
    return { value: null, reason: "unknown_or_conflicting_units" } as const;
  }
  if (
    typeof raw.weight !== "number" ||
    !Number.isFinite(raw.weight) ||
    raw.weight <= 0 ||
    raw.reps !== reps
  ) {
    return { value: null, reason: "missing_or_conflicting_source_values" } as const;
  }
  const expectedWeight =
    unit === "kg" ? raw.weight : Math.round(raw.weight * 0.453592 * 1000) / 1000;
  if (Math.fround(expectedWeight) !== Math.fround(weight)) {
    return { value: null, reason: "missing_or_conflicting_source_values" } as const;
  }
  return { value: weight * (1 + 0.0333 * reps), reason: null } as const;
}

export function estimateStrengthSources<Row extends StrengthEstimateRow & { set_id: string }>(
  sourceRows: Row[],
) {
  let eligible: { value: number; source: Row } | null = null;
  let invalidReason: string | null = null;
  for (const source of sourceRows) {
    const estimate = estimateStrengthSet(source);
    if (estimate.value !== null) {
      if (eligible === null || source.set_id < eligible.source.set_id) {
        eligible = { value: estimate.value, source };
      }
    } else if (estimate.reason !== "fatigue_unknown") {
      invalidReason = estimate.reason;
    }
  }
  if (eligible === null) {
    return { value: null, source: null, reason: invalidReason ?? "fatigue_unknown" } as const;
  }
  if (invalidReason !== null) {
    return { value: null, source: null, reason: "conflicting_failure_evidence" } as const;
  }
  return { ...eligible, reason: null };
}

export function estimateConsolidatedStrengthSet<Row extends StrengthSetRow>(
  set: ConsolidatedSet<Row>,
  flags: string[],
) {
  if (flags.length > 0) return { value: null, source: null, reason: "quality_flags" } as const;
  return estimateStrengthSources(set.sourceRows);
}
