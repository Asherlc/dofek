export interface NutritionDataQualityMessageInput {
  readonly selectedWindowDays: number | null;
  readonly daysWithData: number;
  readonly usableDays: number;
  readonly overlapDays: number;
  readonly conflictDays: number;
  readonly completenessPercent: number | null;
}

export interface NutritionDataQualityMessages {
  readonly recorded: string;
  readonly coverage: string;
  readonly overlap: string;
}

export function formatNutritionDataQualityMessages(
  dataQuality: NutritionDataQualityMessageInput,
): NutritionDataQualityMessages {
  return {
    recorded: `Nutrition data exists on ${dataQuality.daysWithData} selected days.`,
    coverage:
      dataQuality.selectedWindowDays == null
        ? `${dataQuality.usableDays} recorded days are usable.`
        : `${dataQuality.usableDays} of ${dataQuality.selectedWindowDays} selected days are usable (${dataQuality.completenessPercent}% completeness).`,
    overlap:
      dataQuality.overlapDays === 0
        ? "No overlapping nutrition sources detected."
        : `${dataQuality.overlapDays} ${dataQuality.overlapDays === 1 ? "day contains" : "days contain"} overlapping sources; ${dataQuality.conflictDays} ${dataQuality.conflictDays === 1 ? "remains" : "remain"} unresolved.`,
  };
}
