import { formatCalories, formatDateMedium } from "@dofek/format/format";
import { formatMeasurementText } from "@dofek/format/units";
import { textColors } from "@dofek/scoring/colors";
import type {
  BodyFatPrediction,
  WeightPrediction,
} from "../../../server/src/routers/body-analytics.ts";
import { useUnitConverter } from "../lib/unitContext.ts";

interface WeightPredictionSummaryProps {
  prediction: WeightPrediction | BodyFatPrediction;
  metric?: "weight" | "bodyFat";
  hasTrendData?: boolean;
}

function formatDate(isoDate: string): string {
  return formatDateMedium(isoDate);
}

function hasPredictionContent(prediction: WeightPrediction | BodyFatPrediction): boolean {
  return (
    prediction.ratePerWeek != null ||
    ("goal" in prediction && prediction.goal != null) ||
    prediction.periodDeltas.days7 != null ||
    prediction.periodDeltas.days14 != null ||
    prediction.periodDeltas.days30 != null
  );
}

function PeriodDelta({
  label,
  value,
  metric,
}: {
  label: string;
  value: number;
  metric: "weight" | "bodyFat";
}) {
  const units = useUnitConverter();
  if (!Number.isFinite(value)) return null;

  return (
    <div>
      <div className="text-subtle text-xs uppercase">{label}</div>
      <div className="font-medium">
        {value > 0 ? "+" : ""}
        {metric === "weight" ? formatMeasurementText(units.formatWeight(value)) : `${value}%`}
      </div>
    </div>
  );
}

export function WeightPredictionSummary({
  prediction,
  metric = "weight",
  hasTrendData = false,
}: WeightPredictionSummaryProps) {
  const units = useUnitConverter();

  if (!hasPredictionContent(prediction)) {
    return (
      <p className="text-sm text-muted">
        {hasTrendData
          ? metric === "weight"
            ? "Weight trend is available, but a prediction could not be calculated from the current data."
            : "Body-fat trend is available, but a prediction could not be calculated from the current data."
          : metric === "weight"
            ? "Not enough weigh-in data to estimate weight trend yet."
            : "Not enough body-fat readings to estimate a trend yet."}
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
            {metric === "weight"
              ? formatMeasurementText(units.formatWeight(prediction.ratePerWeek))
              : `${prediction.ratePerWeek}%`}
            /wk
          </div>
        </div>
      )}

      {prediction.periodDeltas.days7 != null && (
        <PeriodDelta label="7-Day Change" value={prediction.periodDeltas.days7} metric={metric} />
      )}

      {prediction.periodDeltas.days14 != null && (
        <PeriodDelta label="14-Day Change" value={prediction.periodDeltas.days14} metric={metric} />
      )}

      {prediction.periodDeltas.days30 != null && (
        <PeriodDelta label="30-Day Change" value={prediction.periodDeltas.days30} metric={metric} />
      )}

      {/* Calorie estimate */}
      {metric === "weight" &&
        "impliedDailyCalories" in prediction &&
        prediction.impliedDailyCalories != null && (
          <div>
            <div className="text-subtle text-xs uppercase">Daily Balance</div>
            <div className="font-medium">
              {prediction.impliedDailyCalories > 0 ? "+" : ""}
              {formatCalories(prediction.impliedDailyCalories)}/day
            </div>
          </div>
        )}

      {/* Goal ETA */}
      {metric === "weight" && "goal" in prediction && prediction.goal?.estimatedDate != null && (
        <div>
          <div className="text-subtle text-xs uppercase">Goal Estimate</div>
          <div className="font-medium">
            {formatMeasurementText(units.formatWeight(prediction.goal.goalWeightKg))}
            {" by "}
            <span className="text-muted">~{formatDate(prediction.goal.estimatedDate)}</span>
          </div>
        </div>
      )}

      {metric === "weight" &&
        "goal" in prediction &&
        prediction.goal != null &&
        prediction.goal.estimatedDate == null && (
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
