import type {
  EffortIdentityKind,
  EquivalenceStrength,
  RepeatedEffortKey,
} from "./repeated-effort-types.ts";

const equivalenceRanks: Record<EquivalenceStrength, number> = {
  weak_similarity: 1,
  caller_asserted: 2,
  strong_inferred: 3,
  exact: 4,
};

/** Normalize human-entered identity evidence without changing punctuation or digits. */
export function normalizeIdentityValue(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

/** Build a lossless key for a reusable effort identity. */
export function identityKey(input: {
  kind: EffortIdentityKind;
  namespace: string;
  value: string;
}): string {
  return `${input.kind}:${input.namespace}:${input.value}`;
}

/** Build the provenance-only key for one provider activity instance. */
export function sourceActivityInstanceKey(input: { provider: string; externalId: string }): string {
  return `provider_activity_instance:${input.provider}:${input.externalId}`;
}

/** Compare evidence strengths from strongest to weakest. */
export function rankEquivalenceStrength(
  left: EquivalenceStrength,
  right: EquivalenceStrength,
): number {
  return equivalenceRanks[left] - equivalenceRanks[right];
}

/** Stable lexical comparator over every part of a reusable effort key. */
export function compareRepeatedEffortKeys(
  left: RepeatedEffortKey,
  right: RepeatedEffortKey,
): number {
  const leftKey = identityKey(left);
  const rightKey = identityKey(right);
  if (leftKey === rightKey) return 0;
  return leftKey < rightKey ? -1 : 1;
}
