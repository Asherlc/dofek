export const EPISTEMIC_STATUS_KINDS = [
  "observed",
  "estimated",
  "associated",
  "suggested",
  "unavailable",
] as const;

export type EpistemicStatusKind = (typeof EPISTEMIC_STATUS_KINDS)[number];

export type EpistemicStatus = {
  [K in EpistemicStatusKind]: { kind: K; label: Capitalize<K> };
}[EpistemicStatusKind];

export const EPISTEMIC_STATUS = {
  observed: { kind: "observed", label: "Observed" },
  estimated: { kind: "estimated", label: "Estimated" },
  associated: { kind: "associated", label: "Associated" },
  suggested: { kind: "suggested", label: "Suggested" },
  unavailable: { kind: "unavailable", label: "Unavailable" },
} as const satisfies Record<EpistemicStatusKind, EpistemicStatus>;

export function getEpistemicStatus<K extends EpistemicStatusKind>(
  kind: K,
): (typeof EPISTEMIC_STATUS)[K] {
  return EPISTEMIC_STATUS[kind];
}
