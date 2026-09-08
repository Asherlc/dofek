export interface StrengthComparisonRow {
  activity_id: string;
  set_id: string;
  set_activity_id: string;
  set_provider: string;
  exercise_id: string;
  exercise_index: number;
  set_index: number;
  set_type: string | null;
  weight_kg: number | null;
  reps: number | null;
  rpe: number | null;
}

export interface ClimbingComparisonRow {
  activity_id: string;
  entry_id: string;
  entry_activity_id: string;
  entry_provider: string;
  external_id: string | null;
  climb_type: string;
  grade_system: string;
  grade: string;
  sent: boolean | null;
  attempt_count: number | null;
  lead: boolean | null;
  wall_angle_degrees: number | null;
  route_name: string | null;
  location_name: string | null;
}

function normalized(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function round(value: number, digits = 3): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function strengthQualityFlags(row: StrengthComparisonRow): string[] {
  const flags: string[] = [];
  const loadBearing = row.set_type !== "warmup" && row.set_type !== "rest";
  if (row.set_type === null) flags.push("missing_set_type");
  if (loadBearing && row.reps !== null && row.reps <= 0) flags.push("non_positive_repetitions");
  if (row.reps !== null && row.reps > 100) flags.push("implausible_repetitions");
  if (loadBearing && row.weight_kg !== null && row.weight_kg <= 0)
    flags.push("non_positive_weight");
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

function strengthObservationFingerprint(row: StrengthComparisonRow): string {
  return JSON.stringify([row.set_type, row.weight_kg, row.reps, row.rpe]);
}

function consolidateStrengthRows(rows: StrengthComparisonRow[]) {
  const occurrences = new Map<string, Map<string, Set<number>>>();
  const sourceCounts = new Map<string, Set<string>>();
  for (const row of rows) {
    const activityExercise = JSON.stringify([row.activity_id, row.exercise_id]);
    const bySource = occurrences.get(activityExercise) ?? new Map<string, Set<number>>();
    const sourceOccurrences = bySource.get(row.set_activity_id) ?? new Set<number>();
    sourceOccurrences.add(row.exercise_index);
    bySource.set(row.set_activity_id, sourceOccurrences);
    occurrences.set(activityExercise, bySource);
    const sources = sourceCounts.get(activityExercise) ?? new Set<string>();
    sources.add(`${row.set_activity_id}:${row.set_provider}`);
    sourceCounts.set(activityExercise, sources);
  }
  const sourceLocalOccurrences = new Set(
    [...occurrences.entries()]
      .filter(([, bySource]) => [...bySource.values()].some((indexes) => indexes.size > 1))
      .map(([key]) => key),
  );
  const ambiguousOccurrences = new Set(
    [...sourceLocalOccurrences].filter((key) => (sourceCounts.get(key)?.size ?? 0) > 1),
  );
  const groups = new Map<string, StrengthComparisonRow[]>();
  for (const row of rows) {
    const activityExercise = JSON.stringify([row.activity_id, row.exercise_id]);
    const identity = sourceLocalOccurrences.has(activityExercise)
      ? JSON.stringify([
          row.activity_id,
          row.exercise_id,
          row.set_activity_id,
          row.exercise_index,
          row.set_index,
        ])
      : JSON.stringify([row.activity_id, row.exercise_id, row.set_index]);
    groups.set(identity, [...(groups.get(identity) ?? []), row]);
  }
  const consolidated: Array<{
    row: StrengthComparisonRow;
    sourceRows: StrengthComparisonRow[];
    conflicting: boolean;
    duplicateSameSourceIdentity: boolean;
    ambiguousOccurrence: boolean;
  }> = [];
  for (const group of groups.values()) {
    const candidates: typeof consolidated = [];
    for (const row of group) {
      const duplicate = candidates.find(
        (candidate) =>
          strengthObservationFingerprint(candidate.row) === strengthObservationFingerprint(row) &&
          candidate.sourceRows.every(
            (sourceRow) => sourceRow.set_activity_id !== row.set_activity_id,
          ),
      );
      if (duplicate) duplicate.sourceRows.push(row);
      else {
        candidates.push({
          row,
          sourceRows: [row],
          conflicting: false,
          duplicateSameSourceIdentity: false,
          ambiguousOccurrence: ambiguousOccurrences.has(
            JSON.stringify([row.activity_id, row.exercise_id]),
          ),
        });
      }
    }
    for (const candidate of candidates) {
      candidate.duplicateSameSourceIdentity = candidates.some(
        (other) =>
          other !== candidate &&
          candidate.sourceRows.some((source) =>
            other.sourceRows.some(
              (otherSource) => otherSource.set_activity_id === source.set_activity_id,
            ),
          ),
      );
      candidate.conflicting = candidates.some(
        (other) =>
          other !== candidate &&
          strengthObservationFingerprint(other.row) !==
            strengthObservationFingerprint(candidate.row) &&
          candidate.sourceRows.some((source) =>
            other.sourceRows.some(
              (otherSource) => otherSource.set_activity_id !== source.set_activity_id,
            ),
          ),
      );
    }
    consolidated.push(...candidates);
  }
  return consolidated;
}

export function computeStrengthComparisonMetrics(rows: StrengthComparisonRow[]) {
  if (rows.length === 0) return null;
  const sets = consolidateStrengthRows(rows);
  let volume = 0;
  let validVolumeSets = 0;
  let bestE1rm: number | null = null;
  let suspiciousSets = 0;
  let workingSets = 0;
  let missingVolumeSets = 0;
  let excludedSets = 0;
  for (const set of sets) {
    const row = set.row;
    const flags = [
      ...strengthQualityFlags(row),
      ...(set.conflicting ? ["possible_overlapping_conflicting_set"] : []),
      ...(set.duplicateSameSourceIdentity ? ["duplicate_same_source_set_identity"] : []),
      ...(set.ambiguousOccurrence ? ["ambiguous_cross_provider_exercise_occurrence"] : []),
    ];
    if (flags.length > 0) suspiciousSets += 1;
    const working = ["working", "dropset", "failure"].includes(row.set_type ?? "");
    if (working) workingSets += 1;
    const missingVolume = working && (row.weight_kg === null || row.reps === null);
    if (missingVolume) missingVolumeSets += 1;
    const validVolume =
      flags.length === 0 && working && row.weight_kg !== null && row.reps !== null;
    if ((working && !validVolume) || (!working && flags.length > 0)) excludedSets += 1;
    if (validVolume) {
      volume += row.weight_kg * row.reps;
      validVolumeSets += 1;
      if (row.reps >= 1 && row.reps <= 12 && row.weight_kg > 0) {
        const estimate = row.weight_kg * (1 + row.reps / 30);
        bestE1rm = bestE1rm === null ? estimate : Math.max(bestE1rm, estimate);
      }
    }
  }
  const volumeStatus =
    validVolumeSets === 0
      ? ("unavailable" as const)
      : validVolumeSets === workingSets && excludedSets === 0
        ? ("complete" as const)
        : ("partial" as const);
  const estimatedOneRepMaxStatus =
    bestE1rm === null
      ? ("unavailable" as const)
      : volumeStatus === "complete"
        ? ("complete" as const)
        : ("partial" as const);
  return {
    source_sets: rows.length,
    sets: sets.length,
    working_sets: workingSets,
    valid_volume_sets: validVolumeSets,
    missing_volume_sets: missingVolumeSets,
    valid_volume_kg_reps: validVolumeSets === 0 ? null : round(volume),
    volume_status: volumeStatus,
    best_estimated_one_rep_max_kg: bestE1rm === null ? null : round(bestE1rm, 2),
    estimated_one_rep_max_status: estimatedOneRepMaxStatus,
    suspicious_sets: suspiciousSets,
    excluded_sets: excludedSets,
  };
}

function climbIdentityFingerprint(row: ClimbingComparisonRow): string {
  return JSON.stringify([
    row.activity_id,
    row.climb_type,
    row.grade_system,
    normalized(row.grade),
    row.lead,
    row.wall_angle_degrees,
    row.route_name && normalized(row.route_name),
    row.location_name && normalized(row.location_name),
  ]);
}

function climbObservationFingerprint(row: ClimbingComparisonRow): string {
  return JSON.stringify([climbIdentityFingerprint(row), row.sent, row.attempt_count]);
}

function consolidateClimbingRows(rows: ClimbingComparisonRow[]) {
  const climbs: Array<{ row: ClimbingComparisonRow; sourceRows: ClimbingComparisonRow[] }> = [];
  for (const row of rows) {
    const duplicate = climbs.find(
      (candidate) =>
        climbObservationFingerprint(candidate.row) === climbObservationFingerprint(row) &&
        candidate.sourceRows.every(
          (source) =>
            source.entry_activity_id !== row.entry_activity_id &&
            (source.entry_provider !== row.entry_provider ||
              (row.external_id !== null && source.external_id === row.external_id)),
        ),
    );
    if (duplicate) duplicate.sourceRows.push(row);
    else climbs.push({ row, sourceRows: [row] });
  }
  const ambiguous = new Set<string>();
  const identities = new Map<string, Array<(typeof climbs)[number]>>();
  for (const climb of climbs) {
    const identity = climbIdentityFingerprint(climb.row);
    identities.set(identity, [...(identities.get(identity) ?? []), climb]);
  }
  for (const matching of identities.values()) {
    const providers = unique(
      matching.flatMap((climb) => climb.sourceRows.map((row) => row.entry_provider)),
    );
    const observations = unique(matching.map((climb) => climbObservationFingerprint(climb.row)));
    if (providers.length > 1 && observations.length > 1) {
      for (const climb of matching) ambiguous.add(climb.row.entry_id);
    }
  }
  const stableIds = new Map<string, Array<(typeof climbs)[number]>>();
  for (const climb of climbs) {
    for (const source of climb.sourceRows) {
      if (source.external_id === null) continue;
      const key = `${source.entry_provider}:${source.external_id}`;
      stableIds.set(key, [...(stableIds.get(key) ?? []), climb]);
    }
  }
  for (const matching of stableIds.values()) {
    const distinctClimbs = [...new Set(matching)];
    if (distinctClimbs.length <= 1) continue;
    for (const climb of distinctClimbs) ambiguous.add(climb.row.entry_id);
  }
  return { climbs, ambiguous };
}

export function computeClimbingComparisonMetrics(rows: ClimbingComparisonRow[]) {
  if (rows.length === 0) return null;
  const consolidated = consolidateClimbingRows(rows);
  const valid = consolidated.climbs.filter(
    (climb) => !consolidated.ambiguous.has(climb.row.entry_id),
  );
  const validRows = valid.map((climb) => climb.row);
  const excluded = consolidated.climbs.length - validRows.length;
  const attempts = validRows.flatMap((row) =>
    row.attempt_count === null ? [] : [row.attempt_count],
  );
  const outcomes = validRows.flatMap((row) => (row.sent === null ? [] : [row.sent]));
  const evidence = consolidated.climbs.slice(0, 100).map((climb) => {
    const sourceEntryIds = unique(climb.sourceRows.map((row) => row.entry_id));
    const sourceActivityIds = unique(climb.sourceRows.map((row) => row.entry_activity_id));
    const sourceProviders = unique(climb.sourceRows.map((row) => row.entry_provider));
    return {
      climb_type: climb.row.climb_type,
      grade_system: climb.row.grade_system,
      grade: climb.row.grade,
      route_name: climb.row.route_name,
      location_name: climb.row.location_name,
      sent: climb.row.sent,
      attempt_count: climb.row.attempt_count,
      lead: climb.row.lead,
      status: consolidated.ambiguous.has(climb.row.entry_id)
        ? ("excluded_ambiguous" as const)
        : ("included" as const),
      source_entry_ids: sourceEntryIds.slice(0, 20),
      source_activity_ids: sourceActivityIds.slice(0, 20),
      source_providers: sourceProviders.slice(0, 20),
      source_entry_count: sourceEntryIds.length,
      source_activity_count: sourceActivityIds.length,
      source_provider_count: sourceProviders.length,
      source_evidence_truncated:
        sourceEntryIds.length > 20 || sourceActivityIds.length > 20 || sourceProviders.length > 20,
      merged_duplicate: climb.sourceRows.length > 1,
    };
  });
  return {
    source_entries: rows.length,
    entries: validRows.length,
    excluded_ambiguous_entries: excluded,
    attempts: attempts.length === 0 ? null : attempts.reduce((sum, value) => sum + value, 0),
    attempts_status:
      attempts.length === 0
        ? ("unavailable" as const)
        : attempts.length === validRows.length && excluded === 0
          ? ("complete" as const)
          : ("partial" as const),
    sends: outcomes.length === 0 ? null : outcomes.filter(Boolean).length,
    outcomes_status:
      outcomes.length === 0
        ? ("unavailable" as const)
        : outcomes.length === validRows.length && excluded === 0
          ? ("complete" as const)
          : ("partial" as const),
    observed_grades: unique(validRows.map((row) => `${row.grade_system}:${row.grade}`)),
    evidence,
    evidence_count: consolidated.climbs.length,
    evidence_truncated: consolidated.climbs.length > evidence.length,
  };
}
