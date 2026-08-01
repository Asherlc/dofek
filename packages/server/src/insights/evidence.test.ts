import { describe, expect, it } from "vitest";
import { createInsightEvidence } from "./evidence.ts";

describe("createInsightEvidence", () => {
  it("describes conditional results as observational associations", () => {
    expect(createInsightEvidence("conditional", "25% higher")).toEqual({
      relationship: "descriptive_association",
      label: "Descriptive association",
      method:
        "Observed-group mean comparison (with versus without the behavior); candidate differences use Welch's t-test with Benjamini–Hochberg screening.",
      interpretation:
        "This observational association does not establish that the behavior caused the outcome.",
      limitations:
        "The displayed counts are the observed groups; missing observations and unmeasured confounders may affect this estimate. No confidence interval is available for this exploratory comparison.",
      recommendation: "This is not a prescription or recommendation to change the behavior.",
      estimateLabel: "25% higher",
    });
  });

  it("describes correlations as co-movement rather than causality", () => {
    expect(createInsightEvidence("correlation")).toEqual({
      relationship: "correlation",
      label: "Descriptive correlation",
      method:
        "Spearman rank correlation over paired observations with Benjamini–Hochberg screening.",
      interpretation:
        "This correlation describes co-movement in the observed data; it does not establish causation.",
      limitations:
        "The displayed n is the number of paired observations; missing observations and unmeasured confounders may affect this estimate. No confidence interval is available for this exploratory correlation.",
      recommendation: "Use this as a hypothesis, not a prescription or treatment recommendation.",
    });
  });
});
