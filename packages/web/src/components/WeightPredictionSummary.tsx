import { formatCalories, formatDateMedium } from "@dofek/format/format";
import { formatMeasurementText } from "@dofek/format/units";
import { textColors } from "@dofek/scoring/colors";
import type { WeightPrediction } from "../../../server/src/routers/body-analytics.ts";
import { useUnitConverter } from "../lib/unitContext.ts";

interface WeightPredictionSummaryProps {
  prediction: WeightPrediction;
  hasWeightTrendData?: boolean;
}

function formatDate(isoDate: string): string {
  return formatDateMedium(isoDate);
}

function hasPredictionContent(prediction: WeightPrediction): boolean {
  return (
    prediction.ratePerWeek != null ||
    prediction.goal != null ||
    prediction.periodDeltas.days7 != null ||
    prediction.periodDeltas.days14 != null ||
    prediction.periodDeltas.days30 != null
  );
}

function PeriodDelta({ label, deltaKg }: { label: string; deltaKg: number }) {
  const units = useUnitConverter();
  if (!Number.isFinite(deltaKg)) return null;

  return (
    <div>
      <div className="text-subtle text-xs uppercase">{label}</div>
      <div className="font-medium">
        {deltaKg > 0 ? "+" : ""}
        {formatMeasurementText(units.formatWeight(deltaKg))}
      </div>
    </div>
  );
}

export function WeightPredictionSummary({
  prediction,
  hasWeightTrendData = false,
}: WeightPredictionSummaryProps) {
  const units = useUnitConverter();

  if (!hasPredictionContent(prediction)) {
    return (
      <p className="text-sm text-muted">
        {hasWeightTrendData
          ? "Weight trend is available, but a prediction could not be calculated from the current data."
          : "Not enough weigh-in data to estimate weight trend yet."}
      </p>
    );
  }

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
      {/* Rate */}
      {prediction.ratePerWeek != null && (
        <div>
          <div className="text-subtle text-xs uppercase">Rate</div>
          <div className="font-semibold" style={{ color: textColors.secondary }}>
            {prediction.ratePerWeek > 0 ? "+" : ""}
            {formatMeasurementText(units.formatWeight(prediction.ratePerWeek))}/wk
          </div>
        </div>
      )}

      {prediction.periodDeltas.days7 != null && (
        <PeriodDelta label="7-Day Change" deltaKg={prediction.periodDeltas.days7} />
      )}

      {prediction.periodDeltas.days14 != null && (
        <PeriodDelta label="14-Day Change" deltaKg={prediction.periodDeltas.days14} />
      )}

      {prediction.periodDeltas.days30 != null && (
        <PeriodDelta label="30-Day Change" deltaKg={prediction.periodDeltas.days30} />
      )}

      {/* Calorie estimate */}
      {prediction.impliedDailyCalories != null && (
        <div>
          <div className="text-subtle text-xs uppercase">Daily Balance</div>
          <div className="font-medium">
            {prediction.impliedDailyCalories > 0 ? "+" : ""}
            {formatCalories(prediction.impliedDailyCalories)}/day
          </div>
        </div>
      )}

      {/* Goal ETA */}
      {prediction.goal?.estimatedDate != null && (
        <div>
          <div className="text-subtle text-xs uppercase">Goal Estimate</div>
          <div className="font-medium">
            {formatMeasurementText(units.formatWeight(prediction.goal.goalWeightKg))}
            {" by "}
            <span className="text-muted">~{formatDate(prediction.goal.estimatedDate)}</span>
          </div>
        </div>
      )}

      {prediction.goal != null && prediction.goal.estimatedDate == null && (
        <div>
          <div className="text-subtle text-xs uppercase">Goal</div>
          <div className="font-medium text-muted">
            {formatMeasurementText(units.formatWeight(prediction.goal.goalWeightKg))}
            {" — estimate unavailable"}
          </div>
        </div>
      )}
    </div>
  );
}
