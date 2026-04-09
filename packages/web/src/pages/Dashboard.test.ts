import { UnitConverter } from "@dofek/format/units";
import { describe, expect, it } from "vitest";
import {
  DASHBOARD_GRID_PAIR_SECONDARIES,
  DASHBOARD_GRID_PAIRS,
} from "../lib/dashboardGridPairs.ts";
import { DEFAULT_LAYOUT } from "../lib/dashboardLayoutContext.ts";
import {
  buildSkinTempSeries,
  DASHBOARD_SECTION_IDS,
  healthMonitorSubtitle,
  spo2TempSectionConfig,
} from "./Dashboard";

describe("buildSkinTempSeries", () => {
  const metrics = [
    {
      date: "2026-03-18",
      spo2_avg: 97,
      skin_temp_c: 34.5,
      resting_hr: null,
      hrv: null,
      steps: null,
      active_energy_kcal: null,
    },
    {
      date: "2026-03-19",
      spo2_avg: null,
      skin_temp_c: null,
      resting_hr: null,
      hrv: null,
      steps: null,
      active_energy_kcal: null,
    },
    {
      date: "2026-03-20",
      spo2_avg: 98,
      skin_temp_c: 35.0,
      resting_hr: null,
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

describe("DASHBOARD_SECTION_IDS", () => {
  it("includes spo2Temp section", () => {
    expect(DASHBOARD_SECTION_IDS.has("spo2Temp")).toBe(true);
  });

  it("includes steps section", () => {
    expect(DASHBOARD_SECTION_IDS.has("steps")).toBe(true);
  });

  it("includes sleep section", () => {
    expect(DASHBOARD_SECTION_IDS.has("sleep")).toBe(true);
  });

  it("includes weeklyReport section", () => {
    expect(DASHBOARD_SECTION_IDS.has("weeklyReport")).toBe(true);
  });

  it("includes sleepNeed section (paired with weeklyReport)", () => {
    expect(DASHBOARD_SECTION_IDS.has("sleepNeed")).toBe(true);
  });

  it("includes strain section", () => {
    expect(DASHBOARD_SECTION_IDS.has("strain")).toBe(true);
  });

  it("includes every section from DEFAULT_ORDER", () => {
    for (const sectionId of DEFAULT_LAYOUT.order) {
      expect(
        DASHBOARD_SECTION_IDS.has(sectionId),
        `"${sectionId}" is in DEFAULT_ORDER but missing from DASHBOARD_SECTION_IDS — section will never render`,
      ).toBe(true);
    }
  });
});

describe("grid pair consistency", () => {
  it("every grid pair primary is in DASHBOARD_SECTION_IDS", () => {
    for (const primary of Object.keys(DASHBOARD_GRID_PAIRS)) {
      expect(
        DASHBOARD_SECTION_IDS.has(primary),
        `primary "${primary}" missing from DASHBOARD_SECTION_IDS`,
      ).toBe(true);
    }
  });

  it("every grid pair secondary is in DASHBOARD_SECTION_IDS", () => {
    for (const secondary of Object.values(DASHBOARD_GRID_PAIRS)) {
      expect(
        DASHBOARD_SECTION_IDS.has(secondary),
        `secondary "${secondary}" missing from DASHBOARD_SECTION_IDS`,
      ).toBe(true);
    }
  });

  it("every grid pair primary is in DEFAULT_ORDER", () => {
    for (const primary of Object.keys(DASHBOARD_GRID_PAIRS)) {
      expect(
        DEFAULT_LAYOUT.order.includes(primary),
        `primary "${primary}" missing from DEFAULT_LAYOUT.order`,
      ).toBe(true);
    }
  });

  it("GRID_PAIR_SECONDARY is the inverse of GRID_PAIRS", () => {
    for (const [primary, secondary] of Object.entries(DASHBOARD_GRID_PAIRS)) {
      expect(DASHBOARD_GRID_PAIR_SECONDARIES[secondary]).toBe(primary);
    }
  });
});
