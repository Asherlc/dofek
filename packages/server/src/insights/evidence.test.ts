import { describe, expect, it } from "vitest";
import { createInsightEvidence } from "./evidence.ts";

describe("createInsightEvidence", () => {
  it("describes conditional results as observational associations", () => {
    expect(createInsightEvidence("conditional", "25% higher")).toEqual({
      relationship: "descriptive_association",
      label: "Descriptive association",
      method:
        "Observed-group mean comparison (with versus without the behavior); candidate differences use Welch's t-test with Benjamini–Hochberg screening.",
      limitations: "No confidence interval is available for this comparison.",
      observationWindow: "Daily observations",
      estimateLabel: "25% higher",
    });
  });

  it("describes correlations as co-movement rather than causality", () => {
    expect(createInsightEvidence("correlation")).toEqual({
      relationship: "correlation",
      label: "Descriptive correlation",
      method:
        "Spearman rank correlation over paired observations with Benjamini–Hochberg screening.",
      limitations: "No confidence interval is available for this correlation.",
      observationWindow: "Daily observations",
    });
  });

  it("does not claim multiple-comparison correction for monthly analyses", () => {
    expect(createInsightEvidence("conditional", undefined, "monthly").method).toBe(
      "Observed-group mean comparison across monthly aggregates (with versus without the behavior) using Welch's t-test; no multiple-comparison correction is applied.",
    );
    expect(createInsightEvidence("conditional", undefined, "monthly").observationWindow).toBe(
      "Monthly aggregates",
    );
    expect(createInsightEvidence("correlation", undefined, "monthly").method).toBe(
      "Spearman rank correlation over paired monthly observations; no multiple-comparison correction is applied.",
    );
    expect(createInsightEvidence("correlation", undefined, "monthly").observationWindow).toBe(
      "Monthly aggregates",
    );
  });

  it("describes rolling monthly analyses separately from daily analyses", () => {
    const evidence = createInsightEvidence("conditional", undefined, "rolling_monthly");

    expect(evidence.method).toContain("overlapping 30-day rolling windows");
    expect(evidence.method).toContain("Benjamini–Hochberg");
    expect(evidence.observationWindow).toBe("30-day rolling windows");
  });
});
