import { describe, expect, it, vi } from "vitest";
import { CyclingThresholdEstimator } from "./cycling-threshold-estimator.ts";
import type { CyclingThresholdEvidence } from "./cycling-threshold-repository.ts";

const evidence: CyclingThresholdEvidence = {
  value: 245,
  unit: "watt",
  method: "computed_eftp",
  event_at: "2026-08-01T07:00:00Z",
  evidence_activity_id: "00000000-0000-4000-8000-000000000201",
  evidence_at: "2026-07-15T15:00:00Z",
  evidence_duration_seconds: 1200,
  evidence_power: 260,
  model_version: "reference-v1",
  uncertainty: {
    kind: "not_quantifiable" as const,
    watts: null,
    reason:
      "Reference-curve estimate; individual physiological FTP uncertainty has not been quantified.",
  },
  unavailable_reason: null,
};
function dependencies(value: CyclingThresholdEvidence = evidence) {
  return {
    thresholds: { getAsOf: vi.fn().mockResolvedValue(value) },
    nearbyWeight: {
      getForDate: vi.fn().mockResolvedValue({
        value_kg: 70,
        kind: "measured",
        method: "same_day",
        quality: "high",
        distance_days: 0,
        sources: [],
      }),
    },
  };
}
describe("CyclingThresholdEstimator", () => {
  it("reports canonical eFTP and nearby measured watts per kilogram", async () => {
    const deps = dependencies();
    const result = await new CyclingThresholdEstimator(deps).estimate({
      startDate: "2026-05-01",
      endDate: "2026-08-01",
    });
    expect(result.result).toMatchObject({
      threshold_watts: 245,
      watts_per_kg: 3.5,
      method: "computed_eftp",
      evidence,
      relevant_activity_ids: [evidence.evidence_activity_id],
    });
    expect(deps.thresholds.getAsOf).toHaveBeenCalledWith("2026-08-01");
  });
  it("preserves a specific missing weight reason", async () => {
    const deps = dependencies();
    deps.nearbyWeight.getForDate.mockResolvedValue({ value_kg: null, reason: "No nearby weight" });
    const result = await new CyclingThresholdEstimator(deps).estimate({
      startDate: "2026-05-01",
      endDate: "2026-08-01",
    });
    expect(result.result).toMatchObject({
      threshold_watts: 245,
      watts_per_kg: null,
      watts_per_kg_reason: "No nearby weight",
    });
  });
  it("preserves computed evidence unavailability", async () => {
    const deps = dependencies({
      ...evidence,
      value: null,
      unavailable_reason: "No qualifying effort",
    });
    const result = await new CyclingThresholdEstimator(deps).estimate({
      startDate: "2026-05-01",
      endDate: "2026-08-01",
    });
    expect(result.result).toBeNull();
    expect(result.unavailable_reason).toBe("No qualifying effort");
  });
});
