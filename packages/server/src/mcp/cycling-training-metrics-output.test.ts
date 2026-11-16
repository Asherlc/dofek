import { describe, expect, it } from "vitest";
import { cyclingTrainingMetricsOutputSchema } from "./cycling-training-metrics-output.ts";

describe("cycling training threshold evidence", () => {
  it("accepts configured FTP alongside configured heart-rate thresholds", () => {
    const thresholds = {
      ftp: {
        value: 250,
        unit: "watt",
        effective_from: "2026-06-15",
        source_record_id: "00000000-0000-4000-8000-000000000003",
        kind: "configured",
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

  it("accepts a clear snapshot with null FTP value and configured provenance", () => {
    const thresholds = {
      ftp: {
        value: null,
        unit: "watt",
        effective_from: "2026-06-10",
        source_record_id: "00000000-0000-4000-8000-000000000004",
        kind: "configured",
      },
      threshold_heart_rate: null,
    };
    const schema =
      cyclingTrainingMetricsOutputSchema.shape.result.shape.activities.element.shape.thresholds;
    expect(schema.parse(thresholds)).toEqual(thresholds);
  });
});
