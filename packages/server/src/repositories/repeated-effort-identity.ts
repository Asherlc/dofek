import type { EffortIdentityKind, EquivalenceStrength } from "./repeated-effort-types.ts";

const equivalenceRanks: Record<EquivalenceStrength, number> = {
  weak_similarity: 1,
  caller_asserted: 2,
  strong_inferred: 3,
  exact: 4,
};

/** Build a lossless key for a reusable effort identity. */
export function identityKey(input: {
  kind: EffortIdentityKind;
  namespace: string | null;
  value: string;
}): string {
  return `${input.kind}:${input.namespace ?? ""}:${input.value}`;
}

/** Compare evidence strengths from strongest to weakest. */
export function rankEquivalenceStrength(
  left: EquivalenceStrength,
  right: EquivalenceStrength,
): number {
  return equivalenceRanks[left] - equivalenceRanks[right];
}
