import { describe, expect, it } from "vitest";
import {
  formatRecordedDailyMetric,
  GARMIN_INTERVALS_DISCLOSURE,
  type RecordedDailyMetricRow,
  recordedMetricsNeedGarminDisclosure,
} from "./recorded-daily-metrics.ts";
import { UnitConverter } from "./units.ts";

const row = (overrides: Partial<RecordedDailyMetricRow>): RecordedDailyMetricRow => ({
  date: "2026-03-01",
  metric: "weight",
  value: 70,
  unit: "kg",
  providerId: "intervals.icu",
  sourceName: null,
  ...overrides,
});

describe("formatRecordedDailyMetric", () => {
  it("formats weight with the user's unit system and the exact local date", () => {
    expect(formatRecordedDailyMetric(row({}), new UnitConverter("metric"))).toEqual({
      date: "Mar 1",
      label: "Weight",
      value: "70.0 kg",
    });
    expect(formatRecordedDailyMetric(row({}), new UnitConverter("imperial")).value).toBe(
      "154.3 lb",
    );
  });

  it("formats resting heart rate and labels reported sleep duration as reported", () => {
    const units = new UnitConverter("metric");
    expect(
      formatRecordedDailyMetric(row({ metric: "resting_heart_rate", value: 52 }), units),
    ).toMatchObject({ label: "Resting heart rate", value: "52 bpm" });
    expect(
      formatRecordedDailyMetric(row({ metric: "sleep_duration_reported", value: 27000 }), units),
    ).toMatchObject({ label: "Reported sleep duration", value: "7h 30m" });
  });
});

describe("recordedMetricsNeedGarminDisclosure", () => {
  it("applies only when Intervals.icu observations are present", () => {
    expect(recordedMetricsNeedGarminDisclosure([row({})])).toBe(true);
    expect(recordedMetricsNeedGarminDisclosure([row({ providerId: "withings" })])).toBe(false);
    expect(recordedMetricsNeedGarminDisclosure([])).toBe(false);
    expect(GARMIN_INTERVALS_DISCLOSURE).toContain("Garmin");
  });
});
