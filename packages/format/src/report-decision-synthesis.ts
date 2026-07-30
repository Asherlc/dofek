export const reportDecisionSynthesisSections = [
  { key: "whatChanged", title: "What changed" },
  { key: "likelyAssociations", title: "Likely associations" },
  { key: "whatWorked", title: "What worked" },
  { key: "whatToTryNext", title: "What to try next" },
  { key: "confidenceAndMissingData", title: "Confidence and missing data" },
] as const;

export function keyedDecisionSynthesisItems(
  items: readonly string[],
): { key: string; text: string }[] {
  const occurrences = new Map<string, number>();
  return items.map((text) => {
    const occurrence = occurrences.get(text) ?? 0;
    occurrences.set(text, occurrence + 1);
    return { key: JSON.stringify([text, occurrence]), text };
  });
}
