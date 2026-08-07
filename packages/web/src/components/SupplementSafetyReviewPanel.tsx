import type { MicronutrientSafetyReviewResult } from "../../../server/src/routers/nutrition-analytics.ts";

interface SupplementSafetyReviewPanelProps {
  review: MicronutrientSafetyReviewResult;
}

function statusClasses(status: string): string {
  if (status === "at_or_above_upper_limit") {
    return "border-red-300 bg-red-50 text-red-950";
  }
  if (status === "upper_limit_not_evaluable") {
    return "border-amber-300 bg-amber-50 text-amber-950";
  }
  return "border-border bg-surface-secondary text-foreground";
}

export function SupplementSafetyReviewPanel({ review }: SupplementSafetyReviewPanelProps) {
  const trackedSupplements = review.nutrients.filter(
    (nutrient) => nutrient.intake.supplementDailyAverage > 0,
  );

  return (
    <div className="space-y-3">
      <div
        className={`rounded-lg border p-4 ${
          review.professionalReview.status === "professional_review_recommended"
            ? "border-amber-300 bg-amber-50 text-amber-950"
            : "border-border bg-surface-secondary text-foreground"
        }`}
      >
        <p className="font-medium">Medication and supplement review</p>
        <p className="mt-1 text-sm">{review.professionalReview.message}</p>
        <p className="mt-2 text-xs">{review.professionalReview.limitation}</p>
        <a
          className="mt-2 inline-block text-xs underline"
          href={review.professionalReview.source.url}
          target="_blank"
          rel="noreferrer"
        >
          FDA source
        </a>
      </div>

      {trackedSupplements.length === 0 ? (
        <p className="text-sm text-muted">
          Record supplement doses as taken to compare their nutrient contributions with this bounded
          ruleset.
        </p>
      ) : (
        trackedSupplements.map((nutrient) => (
          <article
            key={nutrient.nutrientId}
            className={`rounded-lg border p-4 ${statusClasses(nutrient.safetyStatus)}`}
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="font-medium">{nutrient.nutrient}</h3>
              <span className="text-xs">
                {nutrient.intake.supplementDailyAverage} {nutrient.unit} average from supplements
                over {nutrient.intake.daysTracked} recorded days
              </span>
            </div>
            <p className="mt-2 text-sm">{nutrient.upperLimit.message}</p>
            {nutrient.upperLimit.status !== "not_in_ruleset" && (
              <a
                className="mt-2 inline-block text-xs underline"
                href={nutrient.upperLimit.source.url}
                target="_blank"
                rel="noreferrer"
              >
                NIH ODS source
              </a>
            )}
          </article>
        ))
      )}
    </div>
  );
}
