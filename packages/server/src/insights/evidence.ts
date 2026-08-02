export type InsightAnalysisType = "conditional" | "correlation" | "discovery";
export type InsightEvidenceScope = "daily" | "rolling_monthly" | "monthly";

export interface InsightEvidence {
  relationship: "descriptive_association" | "correlation";
  label: string;
  method: string;
  interpretation: string;
  limitations: string;
  recommendation: string;
  observationWindow?: string;
  estimateLabel?: string;
}

export function createInsightEvidence(
  analysisType: InsightAnalysisType,
  estimateLabel?: string,
  scope: InsightEvidenceScope = "daily",
): InsightEvidence {
  if (analysisType === "conditional") {
    return {
      relationship: "descriptive_association",
      label: "Descriptive association",
      method:
        scope === "monthly"
          ? "Observed-group mean comparison across monthly aggregates (with versus without the behavior) using Welch's t-test; no multiple-comparison correction is applied."
          : scope === "rolling_monthly"
            ? "Observed-group mean comparison across overlapping 30-day rolling windows (with versus without the behavior); candidate differences use Welch's t-test with Benjamini–Hochberg screening."
            : "Observed-group mean comparison (with versus without the behavior); candidate differences use Welch's t-test with Benjamini–Hochberg screening.",
      interpretation:
        "This observational association does not establish that the behavior caused the outcome.",
      limitations:
        "The displayed counts are the observed groups; missing observations and unmeasured confounders may affect this estimate. No confidence interval is available for this exploratory comparison.",
      recommendation: "This is not a prescription or recommendation to change the behavior.",
      observationWindow:
        scope === "monthly"
          ? "Monthly aggregates"
          : scope === "rolling_monthly"
            ? "30-day rolling windows"
            : "Daily observations",
      ...(estimateLabel === undefined ? {} : { estimateLabel }),
    };
  }

  return {
    relationship: "correlation",
    label: "Descriptive correlation",
    method:
      scope === "monthly"
        ? "Spearman rank correlation over paired monthly observations; no multiple-comparison correction is applied."
        : scope === "rolling_monthly"
          ? "Spearman rank correlation over paired observations from overlapping 30-day rolling windows; dependence-aware inference uses non-overlapping 30-day representatives with Benjamini–Hochberg screening."
          : "Spearman rank correlation over paired observations with Benjamini–Hochberg screening.",
    interpretation:
      "This correlation describes co-movement in the observed data; it does not establish causation.",
    limitations:
      "The displayed n is the number of paired observations; missing observations and unmeasured confounders may affect this estimate. No confidence interval is available for this exploratory correlation.",
    recommendation: "Use this as a hypothesis, not a prescription or treatment recommendation.",
    observationWindow:
      scope === "monthly"
        ? "Monthly aggregates"
        : scope === "rolling_monthly"
          ? "30-day rolling windows"
          : "Daily observations",
  };
}
