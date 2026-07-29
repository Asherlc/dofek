import type { NutritionAnalyticsDataQuality } from "../../../server/src/repositories/nutrition-analytics-repository.ts";

interface NutritionDataQualityPanelProps {
  dataQuality?: NutritionAnalyticsDataQuality;
  loading?: boolean;
}

export function NutritionDataQualityPanel({
  dataQuality,
  loading = false,
}: NutritionDataQualityPanelProps) {
  if (loading) {
    return (
      <section className="card p-4" aria-live="polite">
        <p className="text-sm text-muted">Loading nutrition data quality…</p>
      </section>
    );
  }
  if (!dataQuality) return null;

  const coverage =
    dataQuality.selectedWindowDays == null
      ? `${dataQuality.usableDays} recorded days are usable.`
      : `${dataQuality.usableDays} of ${dataQuality.selectedWindowDays} selected days are usable (${dataQuality.completenessPercent}% completeness).`;
  const overlap =
    dataQuality.overlapDays === 0
      ? "No overlapping nutrition sources detected."
      : `${dataQuality.overlapDays} ${dataQuality.overlapDays === 1 ? "day contains" : "days contain"} overlapping sources; ${dataQuality.conflictDays} ${dataQuality.conflictDays === 1 ? "remains" : "remain"} unresolved.`;

  return (
    <section className="card space-y-2 p-4" aria-labelledby="nutrition-data-quality-title">
      <h2 id="nutrition-data-quality-title" className="font-medium text-foreground">
        Nutrition data quality
      </h2>
      <p className="text-sm text-muted">
        Nutrition data exists on {dataQuality.daysWithData} selected days.
      </p>
      <p className="text-sm text-muted">{coverage}</p>
      <p className="text-sm text-muted">{overlap}</p>
      {dataQuality.contributingSourceLabels.length > 0 && (
        <p className="text-xs text-dim">
          Contributing sources: {dataQuality.contributingSourceLabels.join(", ")}
        </p>
      )}
      {dataQuality.excludedSourceLabels.length > 0 && (
        <p className="text-xs text-dim">
          Excluded or conflicting sources: {dataQuality.excludedSourceLabels.join(", ")}
        </p>
      )}
    </section>
  );
}
