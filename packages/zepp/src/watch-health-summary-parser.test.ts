import { describe, expect, it } from "vitest";
import { parseWatchHealthSummary } from "./watch-health-summary-parser.ts";

const completeSummary = {
  collectedAt: 1_720_003_700_000,
  date: "2024-07-03",
  timezoneOffsetMinutes: -120,
  steps: 1000,
  stepsTarget: 10_000,
  distance: 1200,
  heartRate: [60, 72],
  restingHeartRate: 58,
  heartRateSummary: { maxHr: 150, maxHrTime: 3600 },
  sleep: {
    score: 80,
    deepMinutes: 90,
    startTime: 10,
    endTime: 20,
    totalTime: 480,
    stages: [{ model: 1, start: 10, stop: 20 }],
  },
  nap: [{ length: 20, start: 30, stop: 50 }],
  bloodOxygenCurrent: 98,
  bloodOxygenHourly: [97, 98],
  spo2Recent: [{ spo2: 98, time: 1_720_003_700 }],
  bodyTemperatureCurrent: 36.6,
  bodyTemperature: [36.5, 36.6],
  stress: [20, 30],
  stressByHour: [25],
  stressWeekly: [22],
  standHours: 10,
  pai: 80,
  fatBurning: 30,
  backgroundSamples: [
    {
      recordedAt: "2024-07-03T10:48:20.000Z",
      heartRate: 72,
      bloodOxygenPercent: 98,
      bodyTemperatureCelsius: 36.6,
      stress: 30,
    },
  ],
};

describe("parseWatchHealthSummary", () => {
  it("round-trips every supported field and strips unknown properties", () => {
    expect(parseWatchHealthSummary({ ...completeSummary, privateValue: "discard" })).toEqual(
      completeSummary,
    );
  });

  it.each([
    { ...completeSummary, collectedAt: Number.NaN },
    { ...completeSummary, date: "" },
    { ...completeSummary, activities: [] },
    { ...completeSummary, heartRate: [Number.POSITIVE_INFINITY] },
    { ...completeSummary, heartRateSummary: "invalid" },
    { ...completeSummary, sleep: { ...completeSummary.sleep, stages: [null] } },
    { ...completeSummary, nap: [null] },
    { ...completeSummary, spo2Recent: [null] },
    { ...completeSummary, backgroundSamples: [{ recordedAt: 123 }] },
  ])("rejects malformed restored data %#", (value) => {
    expect(() => parseWatchHealthSummary(value)).toThrow("Watch health summary is invalid.");
  });
});
