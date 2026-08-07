import { formatNutritionDataQualityMessages } from "@dofek/nutrition/nutrition-data-quality";
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

  const messages = formatNutritionDataQualityMessages(dataQuality);

  return (
    <section className="card space-y-2 p-4" aria-labelledby="nutrition-data-quality-title">
      <h2 id="nutrition-data-quality-title" className="font-medium text-foreground">
        Nutrition data quality
      </h2>
      {dataQuality.overlapDays > 0 ? (
        <p className="w-fit rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-300">
          Source overlap to review
        </p>
      ) : null}
      <p className="text-sm text-muted">{messages.recorded}</p>
      <p className="text-sm text-muted">{messages.coverage}</p>
      <p className="text-sm text-muted">{messages.overlap}</p>
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
