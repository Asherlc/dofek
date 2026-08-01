import type { Insight } from "./types.ts";

// ── Human-readable explanation generator ──────────────────────────────────

export const metricUnits: Record<string, string> = {
  "next-day HRV": "ms",
  HRV: "ms",
  "next-day resting HR": "bpm",
  "resting HR": "bpm",
  "sleep duration that night": "min",
  "sleep duration": "min",
  "deep sleep that night": "min",
  "deep sleep": "min",
  "sleep efficiency that night": "%",
  "sleep efficiency": "%",
  "monthly weight change": "kg",
  "monthly body fat change": "%",
  "exercise duration": "min",
};

export function explainInsight(insight: Omit<Insight, "explanation">): string {
  const { type, action, metric, effectSize, confidence } = insight;
  const unit = metricUnits[metric] ?? "";

  if (type === "conditional") {
    const trueM = insight.whenTrue.mean;
    const falseM = insight.whenFalse.mean;
    const diff = Math.abs(trueM - falseM);
    const higher = trueM > falseM;

    // Make the action phrase read naturally
    const actionPhrase =
      /^\d/.test(action) || action.startsWith(">")
        ? `you have ${action.toLowerCase()}`
        : /day$/.test(action)
          ? `it's a ${action.toLowerCase()}`
          : `you get ${action.toLowerCase()}`;

    const freq =
      confidence === "strong"
        ? "consistently"
        : confidence === "emerging"
          ? "generally"
          : "sometimes";

    // Format the diff value with unit
    const fmtDiff = `${diff < 10 ? diff.toFixed(1) : Math.round(diff)}${unit ? ` ${unit}` : ""}`;

    if (metric.includes("weight change") || metric.includes("body fat change")) {
      const what = metric.includes("weight") ? "weight" : "body fat";
      const unitLabel = metric.includes("weight") ? "kg" : "%";
      // Positive mean = gaining, negative = losing
      const withDesc =
        trueM >= 0 ? `+${trueM.toFixed(2)} ${unitLabel}` : `${trueM.toFixed(2)} ${unitLabel}`;
      const withoutDesc =
        falseM >= 0 ? `+${falseM.toFixed(2)} ${unitLabel}` : `${falseM.toFixed(2)} ${unitLabel}`;
      return `Observed association: In months when ${actionPhrase}, ${what} ${freq} changed by ${withDesc}/mo vs ${withoutDesc}/mo without. This does not establish causation or prescribe a behavior change.`;
    }
    const direction = higher ? "higher" : "lower";
    return `Observed association: On days when ${actionPhrase}, ${metric} was ${freq} ${fmtDiff} ${direction} (${trueM.toFixed(1)} vs ${falseM.toFixed(1)}${unit ? ` ${unit}` : ""}). This does not establish causation or prescribe a behavior change.`;
  }

  if (type === "correlation" || type === "discovery") {
    const moreOrHigher = /calories|volume|frequency|protein|carb|fat|fiber|steps|exercise/.test(
      action,
    )
      ? "More"
      : "Higher";
    const upOrDown = effectSize > 0 ? "higher" : "lower";
    return `Observed association: ${moreOrHigher} ${action} was associated with ${upOrDown} ${metric} in the observed data. This does not establish causation or prescribe a behavior change.`;
  }

  return "";
}
