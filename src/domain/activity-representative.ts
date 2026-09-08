import type { CanonicalActivityType } from "@dofek/training/activity-types";
import { compareCodeUnits } from "./code-unit-comparator.ts";

export interface ActivityRepresentativePayload {
  readonly completeStrengthWorkingSetCount: number;
  readonly strengthSetCount: number;
  readonly strengthExerciseCount: number;
  readonly hasSensorData: boolean;
  readonly sensorSampleCount: number;
  readonly hasLocationData: boolean;
  readonly locationSampleCount: number;
  readonly hasElevation: boolean;
}

export interface ActivityRepresentativeCandidate {
  readonly id: string;
  readonly canonicalType: CanonicalActivityType;
  readonly providerType: string | null;
  readonly providerPriority: number;
  readonly payload: ActivityRepresentativePayload;
}

/**
 * Shared lexicographic representative rank.
 *
 * Indices 0-9 are compared descending: complete strength working sets, all
 * strength sets, strength exercises, sensor presence/count, location
 * presence/count, elevation presence, canonical specificity, then provider
 * refinement. Provider priority and member UUID are compared ascending.
 */
export type ActivityRepresentativeRank = readonly [
  completeStrengthWorkingSetCount: number,
  strengthSetCount: number,
  strengthExerciseCount: number,
  sensorPresence: 0 | 1,
  sensorSampleCount: number,
  locationPresence: 0 | 1,
  locationSampleCount: number,
  elevationPresence: 0 | 1,
  canonicalTypeSpecificity: 0 | 1,
  providerTypeRefinement: 0 | 1,
  providerPriority: number,
  memberId: string,
];

function indicator(value: boolean): 0 | 1 {
  return value ? 1 : 0;
}

function isSpecificCanonicalType(canonicalType: CanonicalActivityType): boolean {
  return canonicalType !== "cardio" && canonicalType !== "other";
}

function hasProviderTypeRefinement(
  canonicalType: CanonicalActivityType,
  providerType: string | null,
): boolean {
  const normalizedProviderType = providerType?.trim().toLocaleLowerCase();
  return (
    normalizedProviderType !== undefined &&
    normalizedProviderType !== "" &&
    normalizedProviderType !== canonicalType.toLocaleLowerCase()
  );
}

export function activityRepresentativeRank(
  candidate: ActivityRepresentativeCandidate,
): ActivityRepresentativeRank {
  return [
    candidate.payload.completeStrengthWorkingSetCount,
    candidate.payload.strengthSetCount,
    candidate.payload.strengthExerciseCount,
    indicator(candidate.payload.hasSensorData),
    candidate.payload.sensorSampleCount,
    indicator(candidate.payload.hasLocationData),
    candidate.payload.locationSampleCount,
    indicator(candidate.payload.hasElevation),
    indicator(isSpecificCanonicalType(candidate.canonicalType)),
    indicator(hasProviderTypeRefinement(candidate.canonicalType, candidate.providerType)),
    candidate.providerPriority,
    candidate.id,
  ];
}

function compareActivityRepresentativeRanks(
  left: ActivityRepresentativeRank,
  right: ActivityRepresentativeRank,
): number {
  const descendingRankIndices = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] as const;
  for (const index of descendingRankIndices) {
    const comparison = right[index] - left[index];
    if (comparison !== 0) return comparison;
  }

  const priorityComparison = left[10] - right[10];
  if (priorityComparison !== 0) return priorityComparison;

  return compareCodeUnits(left[11], right[11]);
}

export function selectActivityRepresentative<T extends ActivityRepresentativeCandidate>(
  candidates: readonly T[],
): T | null {
  let selected: T | null = null;
  let selectedRank: ActivityRepresentativeRank | null = null;

  for (const candidate of candidates) {
    const rank = activityRepresentativeRank(candidate);
    if (selectedRank === null || compareActivityRepresentativeRanks(rank, selectedRank) < 0) {
      selected = candidate;
      selectedRank = rank;
    }
  }

  return selected;
}
