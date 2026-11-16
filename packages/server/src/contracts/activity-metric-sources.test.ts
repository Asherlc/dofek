import { describe, expect, it } from "vitest";
import { activityPowerZonesSchema } from "./activity-metric-sources.ts";

const evidence = {
  value: 250,
  unit: "watt",
  method: "configured",
  effective_from: "2026-06-15",
  source_record_id: "00000000-0000-4000-8000-000000000001",
  unavailable_reason: null,
};
const zone = { zone: 1, label: "Recovery", minPct: 0, maxPct: 55, seconds: 30, percent: 100 };
describe("activity power zones contract", () => {
  it("accepts a consistent threshold and explicit unavailable zones", () => {
    expect(
      activityPowerZonesSchema.parse({
        activityDate: "2026-06-15",
        zones: [zone],
        ftp: 250,
        thresholdEvidence: evidence,
      })?.ftp,
    ).toBe(250);
    expect(
      activityPowerZonesSchema.parse({
        activityDate: "2026-06-15",
        zones: [],
        ftp: null,
        thresholdEvidence: {
          ...evidence,
          value: null,
          effective_from: null,
          source_record_id: null,
          unavailable_reason: "No configured FTP",
        },
      })?.zones,
    ).toEqual([]);
  });
  it.each([
    { activityDate: "2026-06-15", zones: [zone], ftp: 240, thresholdEvidence: evidence },
    {
      activityDate: "2026-06-15",
      zones: [zone],
      ftp: null,
      thresholdEvidence: {
        ...evidence,
        value: null,
        effective_from: null,
        source_record_id: null,
        unavailable_reason: "No configured FTP",
      },
    },
  ])("rejects inconsistent zone threshold %j", (value) => {
    expect(activityPowerZonesSchema.safeParse(value).success).toBe(false);
  });
});
