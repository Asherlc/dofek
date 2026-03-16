import { describe, expect, it } from "vitest";
import { buildPolarizationTrendOption } from "./PolarizationTrendChart.tsx";
import { buildRampRateOption } from "./RampRateChart.tsx";

describe("PolarizationTrendChart option builder", () => {
  const sampleWeeks = [
    {
      week: "2024-01-01",
      polarizationIndex: 2.5,
      z1Seconds: 3600,
      z2Seconds: 600,
      z3Seconds: 900,
    },
    {
      week: "2024-01-08",
      polarizationIndex: 1.8,
      z1Seconds: 2400,
      z2Seconds: 1200,
      z3Seconds: 600,
    },
  ];

  it("marks series with empty data as tooltip-hidden", () => {
    const option = buildPolarizationTrendOption(sampleWeeks);
    const seriesWithEmptyData = option.series.filter(
      (s: { data: unknown[] }) => Array.isArray(s.data) && s.data.length === 0,
    );
    for (const s of seriesWithEmptyData) {
      expect(s.tooltip).toEqual(expect.objectContaining({ show: false }));
    }
  });

  it("tooltip formatter returns empty string for empty params", () => {
    const option = buildPolarizationTrendOption(sampleWeeks);
    const formatter = option.tooltip.formatter;
    expect(formatter([])).toBe("");
  });

  it("tooltip formatter handles params with missing data", () => {
    const option = buildPolarizationTrendOption(sampleWeeks);
    const formatter = option.tooltip.formatter;
    // Pass empty params to test robustness (formatter should handle gracefully)
    expect(formatter([{ axisValue: "", value: ["", 0], dataIndex: -1, color: "" }])).toBeDefined();
  });
});

describe("RampRateChart option builder", () => {
  const sampleWeeks = [
    { week: "2024-01-01", rampRate: 3.5 },
    { week: "2024-01-08", rampRate: 6.2 },
  ];

  it("marks series with empty data as tooltip-hidden", () => {
    const option = buildRampRateOption(sampleWeeks);
    const seriesWithEmptyData = option.series.filter(
      (s: { data: unknown[] }) => Array.isArray(s.data) && s.data.length === 0,
    );
    for (const s of seriesWithEmptyData) {
      expect(s.tooltip).toEqual(expect.objectContaining({ show: false }));
    }
  });

  it("tooltip formatter returns empty string for empty params", () => {
    const option = buildRampRateOption(sampleWeeks);
    const formatter = option.tooltip.formatter;
    expect(formatter([])).toBe("");
  });

  it("tooltip formatter handles params with missing data", () => {
    const option = buildRampRateOption(sampleWeeks);
    const formatter = option.tooltip.formatter;
    // Pass params with out-of-range index to test robustness
    expect(formatter([{ dataIndex: -1, value: ["", 0], marker: "" }])).toBeDefined();
  });
});
