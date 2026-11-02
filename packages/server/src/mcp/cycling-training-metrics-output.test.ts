import { describe, expect, it } from "vitest";
import { cyclingTrainingMetricsOutputSchema } from "./cycling-training-metrics-output.ts";

describe("cycling training threshold evidence", () => {
  it("accepts computed power thresholds alongside configured heart-rate thresholds", () => {
    const thresholds = {
      ftp: {
        value: 250,
        unit: "W",
        effective_from: "2026-06-15T00:00:00Z",
        kind: "computed",
        method: "computed_eftp",
        model_version: "test-cycling-model",
        uncertainty: {
          kind: "not_quantifiable",
          watts: null,
          reason: "Individual physiological FTP uncertainty has not been quantified.",
        },
        evidence_activity_id: "00000000-0000-4000-8000-000000000001",
        evidence_at: "2026-06-14T00:00:00Z",
        evidence_duration_seconds: 600,
        evidence_power_watts: 300,
      },
      threshold_heart_rate: {
        value: 175,
        unit: "bpm",
        effective_from: "2026-06-01",
        source_record_id: "00000000-0000-4000-8000-000000000002",
        kind: "configured",
      },
    };
    const schema =
      cyclingTrainingMetricsOutputSchema.shape.result.shape.activities.element.shape.thresholds;
    expect(schema.parse(thresholds)).toEqual(thresholds);
  });
});
