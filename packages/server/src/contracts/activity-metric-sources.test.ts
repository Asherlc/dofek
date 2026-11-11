import { describe, expect, it } from "vitest";
import { activityPowerZonesSchema } from "./activity-metric-sources.ts";
import { cyclingThresholdUncertainty } from "./cycling-threshold.ts";

const evidence = {
  value: 250,
  unit: "watt",
  method: "computed_eftp",
  event_at: null,
  evidence_activity_id: null,
  evidence_at: null,
  evidence_duration_seconds: null,
  evidence_power: null,
  model_version: "v1",
  unavailable_reason: null,
  uncertainty: cyclingThresholdUncertainty,
};
const zone = { zone: 1, label: "Recovery", minPct: 0, maxPct: 55, seconds: 30, percent: 100 };
describe("activity power zones contract", () => {
  it("accepts a consistent threshold and explicit unavailable zones", () => {
    expect(
      activityPowerZonesSchema.parse({ zones: [zone], ftp: 250, thresholdEvidence: evidence })?.ftp,
    ).toBe(250);
    expect(
      activityPowerZonesSchema.parse({
        zones: [],
        ftp: null,
        thresholdEvidence: { ...evidence, value: null, unavailable_reason: "No evidence" },
      })?.zones,
    ).toEqual([]);
  });
  it.each([
    { zones: [zone], ftp: 240, thresholdEvidence: evidence },
    {
      zones: [zone],
      ftp: null,
      thresholdEvidence: { ...evidence, value: null, unavailable_reason: "No evidence" },
    },
  ])("rejects inconsistent zone threshold %j", (value) => {
    expect(activityPowerZonesSchema.safeParse(value).success).toBe(false);
  });
});
