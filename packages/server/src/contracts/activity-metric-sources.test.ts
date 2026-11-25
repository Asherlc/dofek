import { describe, expect, it } from "vitest";
import {
  type ActivityMetricSources,
  activityMetricSourceBindings,
  activityPowerZonesSchema,
  formatActivityMetricSourceHint,
  offeredActivityMetricSources,
} from "./activity-metric-sources.ts";

const evidence = {
  value: 250,
  unit: "watt",
  method: "configured",
  effective_from: "2026-06-15",
  source_record_id: "00000000-0000-4000-8000-000000000001",
  unavailable_reason: null,
};
const zone = { zone: 1, label: "Recovery", minPct: 0, maxPct: 55, seconds: 30, percent: 100 };
const metricSources = [
  {
    key: "heartRate",
    label: "Heart Rate",
    defaultSourceId: "whoop",
    sources: [
      {
        id: "whoop",
        label: "WHOOP",
        presentation: {
          displayName: "WHOOP",
          providerId: "whoop",
          sourceName: null,
          attribution: { kind: "cloud", label: "Cloud" },
        },
      },
      {
        id: "garmin",
        label: "Garmin Edge 840",
        presentation: {
          displayName: "Garmin Edge 840",
          providerId: "garmin",
          sourceName: "Edge 840",
          attribution: null,
        },
      },
    ],
  },
] satisfies ActivityMetricSources;

describe("activity metric source decisions", () => {
  it("keeps offered selections and defaults removed or unknown IDs", () => {
    expect(offeredActivityMetricSources({ heartRate: "garmin" }, metricSources)).toEqual({
      heartRate: "garmin",
    });
    expect(offeredActivityMetricSources({ heartRate: "removed-device" }, metricSources)).toEqual({
      heartRate: "whoop",
    });
    expect(offeredActivityMetricSources({ cadence: "unknown-metric" }, metricSources)).toEqual({
      heartRate: "whoop",
    });
    expect(offeredActivityMetricSources(undefined, undefined)).toEqual({});
  });

  it("binds matching labels and preserves an unknown source with a null label", () => {
    expect(activityMetricSourceBindings({ heartRate: "garmin" }, metricSources)).toEqual({
      heartRate: { sourceId: "garmin", label: "Garmin Edge 840" },
    });
    expect(activityMetricSourceBindings({ heartRate: "removed-device" }, metricSources)).toEqual({
      heartRate: { sourceId: "removed-device", label: null },
    });
  });

  it("formats attribution only while previous readings use a different source", () => {
    expect(
      formatActivityMetricSourceHint(
        true,
        { heartRate: { sourceId: "whoop", label: "WHOOP" } },
        "heartRate",
        "garmin",
      ),
    ).toBe("Showing previous readings from WHOOP");
    expect(
      formatActivityMetricSourceHint(
        true,
        { power: { sourceId: "removed", label: null } },
        "power",
        "garmin",
        "power zone readings",
      ),
    ).toBe("Showing previous power zone readings; source unavailable");
    expect(
      formatActivityMetricSourceHint(
        true,
        { heartRate: { sourceId: "whoop", label: "WHOOP" } },
        "heartRate",
        "whoop",
      ),
    ).toBeUndefined();
    expect(formatActivityMetricSourceHint(false, undefined, "heartRate", "garmin")).toBeUndefined();
  });
});

describe("activity power zones contract", () => {
  it("accepts a consistent threshold and explicit unavailable zones", () => {
    expect(
      activityPowerZonesSchema.parse({
        activityDate: "2026-06-15",
        zones: [zone],
        ftp: 250,
        trainingStressScore: 82,
        thresholdEvidence: evidence,
      })?.ftp,
    ).toBe(250);
    expect(
      activityPowerZonesSchema.parse({
        activityDate: "2026-06-15",
        zones: [],
        ftp: null,
        trainingStressScore: null,
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
  it("requires a nullable trainingStressScore field", () => {
    expect(
      activityPowerZonesSchema.safeParse({
        activityDate: "2026-06-15",
        zones: [zone],
        ftp: 250,
        thresholdEvidence: evidence,
      }).success,
    ).toBe(false);
    expect(
      activityPowerZonesSchema.parse({
        activityDate: "2026-06-15",
        zones: [zone],
        ftp: 250,
        trainingStressScore: 0,
        thresholdEvidence: evidence,
      })?.trainingStressScore,
    ).toBe(0);
  });
  it.each([
    {
      activityDate: "2026-06-15",
      zones: [zone],
      ftp: 240,
      trainingStressScore: null,
      thresholdEvidence: evidence,
    },
    {
      activityDate: "2026-06-15",
      zones: [zone],
      ftp: null,
      trainingStressScore: null,
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
