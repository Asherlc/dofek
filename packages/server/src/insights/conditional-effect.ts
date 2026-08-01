import { metricUnits } from "./explanation.ts";

export const NO_OBSERVED_DIFFERENCE = "No observed difference";

/** Format a conditional effect with one shared absolute-versus-percentage rule. */
export function formatConditionalEffectLabel(
  trueMean: number,
  falseMean: number,
  metric: string,
): string {
  const difference = trueMean - falseMean;
  if (difference === 0) return NO_OBSERVED_DIFFERENCE;

  const direction = difference > 0 ? "higher" : "lower";
  const unit = metricUnits[metric] ?? "";
  const absoluteMetric = metric === "monthly weight change" || metric === "monthly body fat change";
  const baselineNearZero = Math.abs(falseMean) < 1;

  if (absoluteMetric || baselineNearZero) {
    const absoluteDifference = Math.abs(difference);
    if (Number(absoluteDifference.toFixed(2)) === 0) return NO_OBSERVED_DIFFERENCE;
    return `${absoluteDifference.toFixed(2)}${unit ? ` ${unit}` : ""} ${direction}`;
  }

  const percentageDifference = (Math.abs(difference) / Math.abs(falseMean)) * 100;
  if (Number(percentageDifference.toFixed(0)) === 0) return NO_OBSERVED_DIFFERENCE;
  return `${percentageDifference.toFixed(0)}% ${direction}`;
}
