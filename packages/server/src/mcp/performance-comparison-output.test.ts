import { describe, expect, it } from "vitest";
import { cyclingEffortMetricsSchema } from "./performance-comparison-output.ts";

describe("cycling effort threshold evidence", () => {
  it("accepts configured FTP provenance", () => {
    const thresholds = {
      ftp: {
        value: 250,
        unit: "watt",
        effective_from: "2026-06-15",
        source_record_id: "00000000-0000-4000-8000-000000000003",
        kind: "configured",
      },
      thresholdHeartRateBpm: 175,
      ageDays: 1,
      freshness: "configured",
      freshnessReason: "User-entered FTP is effective for this activity date.",
    };
    expect(cyclingEffortMetricsSchema.shape.thresholds.parse(thresholds)).toEqual(thresholds);
  });
});
