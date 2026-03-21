import { describe, expect, it } from "vitest";
import { buildPolarizationTrendOption } from "./PolarizationTrendChart.tsx";
import { buildRampRateOption } from "./RampRateChart.tsx";
import { buildSleepAnalyticsOption } from "./SleepAnalyticsChart.tsx";

/**
 * Helper to extract typed fields from ECharts options (which return ECBasicOption).
 * Uses runtime checks instead of `as` casts to satisfy the linter.
 */
function getSeriesArray(
  option: Record<string, unknown>,
): Array<{ data: unknown[]; tooltip?: { show: boolean }; name?: string }> {
  const series = option.series;
  if (!Array.isArray(series)) throw new Error("Expected series to be an array");
  return series;
}

function getTooltipFormatter(option: Record<string, unknown>): (...args: unknown[]) => string {
  const tooltip = option.tooltip;
  if (typeof tooltip !== "object" || tooltip === null) throw new Error("Expected tooltip object");
  if (!("formatter" in tooltip)) throw new Error("Expected tooltip.formatter");
  const { formatter } = tooltip;
  if (typeof formatter !== "function")
    throw new Error("Expected tooltip.formatter to be a function");
  return (...args: unknown[]) => String(formatter(...args));
}

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
    const series = getSeriesArray(option);
    const seriesWithEmptyData = series.filter((s) => Array.isArray(s.data) && s.data.length === 0);
    for (const s of seriesWithEmptyData) {
      expect(s.tooltip).toEqual(expect.objectContaining({ show: false }));
    }
  });

  it("tooltip formatter returns empty string for empty params", () => {
    const option = buildPolarizationTrendOption(sampleWeeks);
    const formatter = getTooltipFormatter(option);
    expect(formatter([])).toBe("");
  });

  it("tooltip formatter handles params with missing data", () => {
    const option = buildPolarizationTrendOption(sampleWeeks);
    const formatter = getTooltipFormatter(option);
    expect(formatter([{ axisValue: "", value: ["", 0], dataIndex: -1, color: "" }])).toBeDefined();
  });

  it("keeps week points even when polarization index is null", () => {
    const weeksWithGap = [
      {
        week: "2024-01-01",
        polarizationIndex: null,
        z1Seconds: 3600,
        z2Seconds: 0,
        z3Seconds: 900,
      },
      {
        week: "2024-01-08",
        polarizationIndex: 1.9,
        z1Seconds: 2400,
        z2Seconds: 1200,
        z3Seconds: 600,
      },
    ];

    const option = buildPolarizationTrendOption(weeksWithGap);
    const series = getSeriesArray(option);
    const polarizationSeries = series.find((s) => s.name === "Polarization Index");
    expect(polarizationSeries).toBeDefined();
    if (!polarizationSeries) throw new Error("Expected polarization series");
    expect(polarizationSeries.data).toHaveLength(2);
    expect(polarizationSeries.data[0]).toHaveProperty("value", ["2024-01-01", null]);
    expect(polarizationSeries.data[1]).toHaveProperty("value", ["2024-01-08", 1.9]);
  });

  it("tooltip shows %HRmax zone labels (not Karvonen %HRR)", () => {
    const option = buildPolarizationTrendOption(sampleWeeks);
    const formatter = getTooltipFormatter(option);
    const html = formatter([
      {
        axisValue: "2024-01-01",
        value: ["2024-01-01", 2.5],
        dataIndex: 0,
        color: "",
        seriesName: "Polarization Index",
      },
    ]);
    expect(html).toContain("<80% max HR");
    expect(html).toContain("80-90% max HR");
    expect(html).toContain("≥90% max HR");
    expect(html).not.toContain("HRR");
    expect(html).not.toContain("Karvonen");
    expect(html).not.toContain("resting");
  });

  it("does not use visualMap (crashes ECharts piecewise with coord error)", () => {
    const option = buildPolarizationTrendOption(sampleWeeks);
    expect(option).not.toHaveProperty("visualMap");
  });

  it("does not use markLine (incompatible with ECharts visualMap)", () => {
    const option = buildPolarizationTrendOption(sampleWeeks);
    for (const series of getSeriesArray(option)) {
      expect(series).not.toHaveProperty("markLine");
    }
  });

  it("renders threshold as a regular line series at y=2.0", () => {
    const option = buildPolarizationTrendOption(sampleWeeks);
    const thresholdSeries = getSeriesArray(option).find((s) => s.name === "Threshold");
    expect(thresholdSeries).toBeDefined();
    if (!thresholdSeries) throw new Error("Expected threshold series");
    const data = thresholdSeries.data;
    expect(data[0]).toEqual(["2024-01-01", 2.0]);
    expect(data[1]).toEqual(["2024-01-08", 2.0]);
  });

  it("colors data points green at or above 2.0 and red below 2.0", () => {
    const weeksWithBoundary = [
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
      {
        week: "2024-01-15",
        polarizationIndex: 2.0,
        z1Seconds: 3000,
        z2Seconds: 800,
        z3Seconds: 700,
      },
    ];
    const option = buildPolarizationTrendOption(weeksWithBoundary);
    const polarizationIndexSeries = getSeriesArray(option).find(
      (s) => s.name === "Polarization Index",
    );
    if (!polarizationIndexSeries) throw new Error("Expected polarization index series");
    const piData = polarizationIndexSeries.data;
    // 2.5 (above threshold) → green
    expect(piData[0]).toHaveProperty("itemStyle", { color: "#22c55e" });
    // 1.8 (below threshold) → red
    expect(piData[1]).toHaveProperty("itemStyle", { color: "#ef4444" });
    // 2.0 (exactly at threshold) → green
    expect(piData[2]).toHaveProperty("itemStyle", { color: "#22c55e" });
  });

  it("explains missing zones when PI is unavailable", () => {
    const weeksWithGap = [
      {
        week: "2024-01-01",
        polarizationIndex: null,
        z1Seconds: 3600,
        z2Seconds: 0,
        z3Seconds: 900,
      },
      {
        week: "2024-01-08",
        polarizationIndex: 1.9,
        z1Seconds: 2400,
        z2Seconds: 1200,
        z3Seconds: 600,
      },
    ];

    const option = buildPolarizationTrendOption(weeksWithGap);
    const formatter = getTooltipFormatter(option);
    const html = formatter([
      {
        axisValue: "2024-01-01",
        value: ["2024-01-01", null],
        dataIndex: 0,
        color: "",
        seriesName: "Polarization Index",
      },
    ]);
    expect(html).toContain("Insufficient zone coverage");
    expect(html).toContain("Missing zones this week: Zone 2");
  });
});

describe("RampRateChart option builder", () => {
  const sampleWeeks = [
    { week: "2024-01-01", rampRate: 3.5 },
    { week: "2024-01-08", rampRate: 6.2 },
  ];

  it("marks series with empty data as tooltip-hidden", () => {
    const option = buildRampRateOption(sampleWeeks);
    const series = getSeriesArray(option);
    const seriesWithEmptyData = series.filter((s) => Array.isArray(s.data) && s.data.length === 0);
    for (const s of seriesWithEmptyData) {
      expect(s.tooltip).toEqual(expect.objectContaining({ show: false }));
    }
  });

  it("tooltip formatter returns empty string for empty params", () => {
    const option = buildRampRateOption(sampleWeeks);
    const formatter = getTooltipFormatter(option);
    expect(formatter([])).toBe("");
  });

  it("tooltip formatter handles params with missing data", () => {
    const option = buildRampRateOption(sampleWeeks);
    const formatter = getTooltipFormatter(option);
    expect(formatter([{ dataIndex: -1, value: ["", 0], marker: "" }])).toBeDefined();
  });
});

describe("SleepAnalyticsChart option builder", () => {
  const sampleNightly = [
    {
      date: "2026-03-10",
      durationMinutes: 450,
      deepPct: 18,
      remPct: 22,
      lightPct: 52,
      awakePct: 8,
      efficiency: 91,
      rollingAvgDuration: 440,
    },
    {
      date: "2026-03-11",
      durationMinutes: 430,
      deepPct: 16,
      remPct: 24,
      lightPct: 51,
      awakePct: 9,
      efficiency: 89,
      rollingAvgDuration: 436,
    },
  ];

  it("places sleep debt annotation on its own row beneath the legend", () => {
    const option = buildSleepAnalyticsOption(sampleNightly, -72);
    const graphic = option.graphic;
    if (!Array.isArray(graphic)) throw new Error("Expected graphic to be an array");
    const [firstGraphic] = graphic;
    expect(firstGraphic).toBeDefined();
    if (!firstGraphic) {
      throw new Error("Expected a sleep debt graphic annotation");
    }

    const legend = option.legend;
    if (typeof legend !== "object" || legend === null || !("top" in legend))
      throw new Error("Expected legend with top");
    expect(legend.top).toBe(0);
    expect(firstGraphic.top).toBeGreaterThanOrEqual(24);
    const grid = option.grid;
    if (typeof grid !== "object" || grid === null || !("top" in grid))
      throw new Error("Expected grid with top");
    expect(grid.top).toBeGreaterThan(60);
  });

  it("formats debt text as deficit when debt is positive", () => {
    const option = buildSleepAnalyticsOption(sampleNightly, 126);
    const graphic = option.graphic;
    if (!Array.isArray(graphic)) throw new Error("Expected graphic to be an array");
    const [firstGraphic] = graphic;
    expect(firstGraphic).toBeDefined();
    if (!firstGraphic) {
      throw new Error("Expected a sleep debt graphic annotation");
    }

    expect(firstGraphic.style.text).toContain("14d Sleep Debt:");
    expect(firstGraphic.style.text).toContain("deficit");
    expect(firstGraphic.style.fill).toBe("#ef4444");
  });
});
