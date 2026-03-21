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
  const record: Record<string, unknown> = Object.assign({}, tooltip);
  const formatter = record.formatter;
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
    expect(polarizationSeries?.data).toEqual([
      ["2024-01-01", null],
      ["2024-01-08", 1.9],
    ]);
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

  it("restricts visualMap to only the Polarization Index data series to avoid markLine coord crash", () => {
    const option = buildPolarizationTrendOption(sampleWeeks);
    const polarizationIndexSeriesIndex = option.series.findIndex(
      (s: { name?: string }) => s.name === "Polarization Index",
    );
    expect(polarizationIndexSeriesIndex).toBeGreaterThan(0);
    expect(option.visualMap.seriesIndex).toBe(polarizationIndexSeriesIndex);
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
    if (typeof legend !== "object" || legend === null) throw new Error("Expected legend");
    const legendRecord: Record<string, unknown> = Object.assign({}, legend);
    expect(legendRecord.top).toBe(0);
    expect(firstGraphic.top).toBeGreaterThanOrEqual(24);
    const grid = option.grid;
    if (typeof grid !== "object" || grid === null) throw new Error("Expected grid");
    const gridRecord: Record<string, unknown> = Object.assign({}, grid);
    expect(gridRecord.top).toBeGreaterThan(60);
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
