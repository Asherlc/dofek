import type { WeightPrediction } from "../../../server/src/routers/body-analytics.ts";
import { formatNumber } from "../lib/format.ts";
import { useUnitConverter } from "../lib/unitContext.ts";

interface WeightPredictionSummaryProps {
  prediction: WeightPrediction;
}

function formatDate(isoDate: string): string {
  const date = new Date(`${isoDate}T12:00:00`);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function WeightPredictionSummary({ prediction }: WeightPredictionSummaryProps) {
  const units = useUnitConverter();

  if (prediction.ratePerWeek == null) return null;

  const rateConverted = units.convertWeight(prediction.ratePerWeek);
  const rateColor =
    Math.abs(prediction.ratePerWeek) < 0.05
      ? "text-muted"
      : prediction.ratePerWeek > 0
        ? "text-green-400"
        : "text-red-400";

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
      {/* Rate */}
      <div>
        <div className="text-subtle text-xs uppercase">Rate</div>
        <div className={`font-semibold ${rateColor}`}>
          {rateConverted > 0 ? "+" : ""}
          {formatNumber(rateConverted)} {units.weightLabel}/wk
        </div>
      </div>

      {/* Period deltas */}
      {prediction.periodDeltas.days7 != null && (
        <div>
          <div className="text-subtle text-xs uppercase">7-Day Change</div>
          <div className="font-medium">
            {units.convertWeight(prediction.periodDeltas.days7) > 0 ? "+" : ""}
            {formatNumber(units.convertWeight(prediction.periodDeltas.days7))} {units.weightLabel}
          </div>
        </div>
      )}

      {/* Calorie estimate */}
      {prediction.impliedDailyCalories != null && (
        <div>
          <div className="text-subtle text-xs uppercase">Daily Balance</div>
          <div className="font-medium">
            {prediction.impliedDailyCalories > 0 ? "+" : ""}
            {Math.round(prediction.impliedDailyCalories)} kcal/day
          </div>
        </div>
      )}

      {/* Goal ETA */}
      {prediction.goal?.estimatedDate != null && (
        <div>
          <div className="text-subtle text-xs uppercase">Goal Estimate</div>
          <div className="font-medium">
            {formatNumber(units.convertWeight(prediction.goal.goalWeightKg))} {units.weightLabel}
            {" by "}
            <span className="text-muted">~{formatDate(prediction.goal.estimatedDate)}</span>
          </div>
        </div>
      )}

      {prediction.goal != null && prediction.goal.estimatedDate == null && (
        <div>
          <div className="text-subtle text-xs uppercase">Goal</div>
          <div className="font-medium text-muted">
            {formatNumber(units.convertWeight(prediction.goal.goalWeightKg))} {units.weightLabel}
            {" — estimate unavailable"}
          </div>
        </div>
      )}
    </div>
  );
}
