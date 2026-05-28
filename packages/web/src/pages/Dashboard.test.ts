import { UnitConverter } from "@dofek/format/units";
import { describe, expect, it } from "vitest";
import {
  buildHealthMetrics,
  buildSkinTempSeries,
  healthMonitorSubtitle,
  spo2TempSectionConfig,
} from "./Dashboard";

describe("buildSkinTempSeries", () => {
  const metrics = [
    {
      date: "2026-03-18",
      spo2_avg: 97,
      skin_temp_c: 34.5,
      hrv: null,
      steps: null,
      active_energy_kcal: null,
    },
    {
      date: "2026-03-19",
      spo2_avg: null,
      skin_temp_c: null,
      hrv: null,
      steps: null,
      active_energy_kcal: null,
    },
    {
      date: "2026-03-20",
      spo2_avg: 98,
      skin_temp_c: 35.0,
      hrv: null,
      steps: null,
      active_energy_kcal: null,
    },
  ];

  it("assigns skin temp series to the second y-axis (yAxisIndex: 1)", () => {
    const series = buildSkinTempSeries(metrics, new UnitConverter("metric"));
    expect(series.yAxisIndex).toBe(1);
  });

  it("converts temperature values using the given unit system", () => {
    const metricSeries = buildSkinTempSeries(metrics, new UnitConverter("metric"));
    const metricValues = metricSeries.data.map(([, v]) => v);
    expect(metricValues).toEqual([34.5, null, 35.0]);

    const imperialSeries = buildSkinTempSeries(metrics, new UnitConverter("imperial"));
    const imperialValues = imperialSeries.data.map(([, v]) => v);
    // 34.5°C = 94.1°F, 35.0°C = 95.0°F
    expect(imperialValues[0]).toBeCloseTo(94.1, 1);
    expect(imperialValues[1]).toBeNull();
    expect(imperialValues[2]).toBeCloseTo(95.0, 1);
  });

  it("uses date strings as the x-axis values", () => {
    const series = buildSkinTempSeries(metrics, new UnitConverter("metric"));
    expect(series.data.map(([date]) => date)).toEqual(["2026-03-18", "2026-03-19", "2026-03-20"]);
  });
});

describe("spo2TempSectionConfig", () => {
  it("returns combined title and dual axes when both SpO2 and skin temp are present", () => {
    const config = spo2TempSectionConfig(true, true, new UnitConverter("imperial"));
    expect(config.title).toBe("SpO2 & Skin Temperature");
    expect(config.subtitle).toContain("oxygen");
    expect(config.subtitle).toContain("skin");
    expect(config.yAxis).toHaveLength(2);
    expect(config.yAxis[0]?.name).toBe("SpO2 (%)");
    expect(config.yAxis[1]?.name).toBe("°F");
  });

  it("returns SpO2-only title and single axis when only SpO2 data exists", () => {
    const config = spo2TempSectionConfig(true, false, new UnitConverter("metric"));
    expect(config.title).toBe("Blood Oxygen (SpO2)");
    expect(config.subtitle).toContain("oxygen");
    expect(config.subtitle).not.toContain("skin");
    expect(config.yAxis).toHaveLength(1);
    expect(config.yAxis[0]?.name).toBe("SpO2 (%)");
  });

  it("returns skin temp-only title and single axis when only skin temp exists", () => {
    const config = spo2TempSectionConfig(false, true, new UnitConverter("metric"));
    expect(config.title).toBe("Skin Temperature");
    expect(config.subtitle).toContain("skin");
    expect(config.subtitle).not.toContain("oxygen");
    expect(config.yAxis).toHaveLength(1);
    expect(config.yAxis[0]?.name).toBe("°C");
  });

  it("uses imperial temperature label when unit system is imperial", () => {
    const config = spo2TempSectionConfig(false, true, new UnitConverter("imperial"));
    expect(config.yAxis[0]?.name).toBe("°F");
  });
});

describe("healthMonitorSubtitle", () => {
  it("returns latest values label", () => {
    expect(healthMonitorSubtitle()).toBe("Latest values vs. rolling average");
  });
});

describe("buildHealthMetrics", () => {
  it("includes resting heart rate as a lower-is-better health metric", () => {
    const metrics = buildHealthMetrics(
      {
        avg_hrv: 43.8,
        avg_resting_hr: 56.2,
        avg_spo2: null,
        avg_steps: null,
        avg_active_energy: null,
        avg_skin_temp: null,
        stddev_hrv: 7.5,
        stddev_resting_hr: 3.1,
        stddev_spo2: null,
        stddev_skin_temp: null,
        latest_hrv: 48,
        latest_resting_hr: 55,
        latest_spo2: null,
        latest_steps: null,
        latest_active_energy: null,
        latest_skin_temp: null,
        latest_date: "2025-03-15",
      },
      new UnitConverter("metric"),
    );

    expect(metrics).toContainEqual({
      label: "Resting Heart Rate",
      value: 55,
      avg: 56.2,
      stddev: 3.1,
      unit: "bpm",
      lowerBetter: true,
    });
  });
});
