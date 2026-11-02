import { describe, expect, it } from "vitest";
import { cyclingEffortMetricsSchema } from "./performance-comparison-output.ts";

describe("cycling effort threshold evidence", () => {
  it("accepts the computed threshold and its qualifying power evidence", () => {
    const thresholds = {
      ftp: {
        value: 250,
        effectiveFrom: "2026-06-15T00:00:00Z",
        kind: "computed",
        method: "computed_eftp",
        modelVersion: "test-cycling-model",
        uncertainty: {
          kind: "not_quantifiable",
          watts: null,
          reason: "Individual physiological FTP uncertainty has not been quantified.",
        },
        evidenceActivityId: "00000000-0000-4000-8000-000000000001",
        evidenceAt: "2026-06-14T00:00:00Z",
        evidenceDurationSeconds: 600,
        evidencePowerWatts: 300,
      },
      thresholdHeartRateBpm: 175,
      ageDays: 1,
      freshness: "computed",
      freshnessReason: "Computed from observed cycling power history.",
    };
    expect(cyclingEffortMetricsSchema.shape.thresholds.parse(thresholds)).toEqual(thresholds);
  });
});
