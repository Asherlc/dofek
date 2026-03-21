import { describe, expect, it } from "vitest";
import {
  AXIS_LABEL_COLOR,
  AXIS_LINE_COLOR,
  CHART_THEME,
  createChartOptions,
  LEGEND_TEXT_COLOR,
  SPLIT_LINE_COLOR,
  TOOLTIP_BG,
  TOOLTIP_BORDER,
  TOOLTIP_TEXT_COLOR,
} from "./chart-theme.ts";

describe("CHART_THEME", () => {
  it("has transparent background", () => {
    expect(CHART_THEME.backgroundColor).toBe("transparent");
  });

  it("has dark tooltip styling", () => {
    expect(CHART_THEME.tooltip.backgroundColor).toBe("#18181b");
    expect(CHART_THEME.tooltip.borderColor).toBe("#3f3f46");
    expect(CHART_THEME.tooltip.textStyle).toEqual({ color: "#e4e4e7", fontSize: 12 });
  });

  it("has dark axis label styling", () => {
    expect(CHART_THEME.xAxis.axisLabel).toEqual({ color: "#71717a", fontSize: 11 });
    expect(CHART_THEME.xAxis.axisLine).toEqual({ lineStyle: { color: "#3f3f46" } });
  });

  it("has dark yAxis styling", () => {
    expect(CHART_THEME.yAxis.splitLine).toEqual({ lineStyle: { color: "#27272a" } });
    expect(CHART_THEME.yAxis.axisLabel).toEqual({ color: "#71717a", fontSize: 11 });
    expect(CHART_THEME.yAxis.nameTextStyle).toEqual({ color: "#71717a", fontSize: 11 });
  });

  it("has dark legend styling", () => {
    expect(CHART_THEME.legend.textStyle).toEqual({ color: "#a1a1aa", fontSize: 11 });
  });
});

describe("color constants", () => {
  it("exports tooltip colors", () => {
    expect(TOOLTIP_BG).toBe("#18181b");
    expect(TOOLTIP_BORDER).toBe("#3f3f46");
    expect(TOOLTIP_TEXT_COLOR).toBe("#e4e4e7");
  });

  it("exports axis colors", () => {
    expect(AXIS_LABEL_COLOR).toBe("#71717a");
    expect(AXIS_LINE_COLOR).toBe("#3f3f46");
    expect(SPLIT_LINE_COLOR).toBe("#27272a");
  });

  it("exports legend color", () => {
    expect(LEGEND_TEXT_COLOR).toBe("#a1a1aa");
  });
});

describe("createChartOptions", () => {
  it("returns theme defaults when called with empty overrides", () => {
    const options = createChartOptions({});
    expect(options.backgroundColor).toBe("transparent");
    expect(options.tooltip.backgroundColor).toBe("#18181b");
    expect(options.tooltip.borderColor).toBe("#3f3f46");
    expect(options.tooltip.textStyle).toEqual({ color: "#e4e4e7", fontSize: 12 });
  });

  it("merges top-level overrides", () => {
    const options = createChartOptions({
      series: [{ type: "line", data: [[1, 2]] }],
    });
    expect(options.series).toEqual([{ type: "line", data: [[1, 2]] }]);
    expect(options.backgroundColor).toBe("transparent");
  });

  it("deep-merges nested tooltip overrides", () => {
    const options = createChartOptions({
      tooltip: {
        trigger: "axis" as const,
        formatter: "custom",
      },
    });
    // Overrides applied
    expect(options.tooltip.trigger).toBe("axis");
    expect(options.tooltip.formatter).toBe("custom");
    // Defaults preserved
    expect(options.tooltip.backgroundColor).toBe("#18181b");
    expect(options.tooltip.borderColor).toBe("#3f3f46");
    expect(options.tooltip.textStyle).toEqual({ color: "#e4e4e7", fontSize: 12 });
  });

  it("deep-merges nested xAxis overrides", () => {
    const options = createChartOptions({
      xAxis: {
        type: "time" as const,
        splitLine: { show: false },
      },
    });
    const xAxis = options.xAxis;
    expect(Array.isArray(xAxis)).toBe(false);
    if (Array.isArray(xAxis)) throw new Error("Expected object");
    expect(xAxis.type).toBe("time");
    expect(xAxis.splitLine).toEqual({ show: false });
    // Defaults preserved
    expect(xAxis.axisLabel).toEqual({ color: "#71717a", fontSize: 11 });
    expect(xAxis.axisLine).toEqual({ lineStyle: { color: "#3f3f46" } });
  });

  it("deep-merges nested yAxis overrides (single axis)", () => {
    const options = createChartOptions({
      yAxis: {
        type: "value" as const,
        name: "Stress (0-3)",
        min: 0,
        max: 3,
      },
    });
    const yAxis = options.yAxis;
    expect(Array.isArray(yAxis)).toBe(false);
    if (Array.isArray(yAxis)) throw new Error("Expected object");
    expect(yAxis.type).toBe("value");
    expect(yAxis.name).toBe("Stress (0-3)");
    expect(yAxis.min).toBe(0);
    expect(yAxis.max).toBe(3);
    // Defaults preserved
    expect(yAxis.splitLine).toEqual({ lineStyle: { color: "#27272a" } });
    expect(yAxis.axisLabel).toEqual({ color: "#71717a", fontSize: 11 });
    expect(yAxis.nameTextStyle).toEqual({ color: "#71717a", fontSize: 11 });
  });

  it("passes through yAxis array without merging defaults into each element", () => {
    const yAxes = [
      { type: "value" as const, name: "Left", axisLabel: { color: "#71717a", fontSize: 11 } },
      { type: "value" as const, name: "Right", position: "right" as const },
    ];
    const options = createChartOptions({ yAxis: yAxes });
    // Array should be passed through as-is
    expect(Array.isArray(options.yAxis)).toBe(true);
    expect(options.yAxis).toEqual(yAxes);
  });

  it("passes through xAxis array without merging defaults", () => {
    const xAxes = [
      { type: "time" as const, gridIndex: 0, axisLabel: { show: false } },
      { type: "time" as const, gridIndex: 1, axisLabel: { color: "#71717a", fontSize: 11 } },
    ];
    const options = createChartOptions({ xAxis: xAxes });
    expect(Array.isArray(options.xAxis)).toBe(true);
    expect(options.xAxis).toEqual(xAxes);
  });

  it("deep-merges legend overrides", () => {
    const options = createChartOptions({
      legend: {
        data: ["a", "b"],
        top: 0,
      },
    });
    expect(options.legend.data).toEqual(["a", "b"]);
    expect(options.legend.top).toBe(0);
    // Default preserved
    expect(options.legend.textStyle).toEqual({ color: "#a1a1aa", fontSize: 11 });
  });

  it("allows overriding grid", () => {
    const options = createChartOptions({
      grid: { top: 80, right: 60, bottom: 40, left: 50 },
    });
    expect(options.grid).toEqual({ top: 80, right: 60, bottom: 40, left: 50 });
  });

  it("allows grid arrays for multi-panel charts", () => {
    const grids = [
      { top: 10, right: 15, bottom: "42%", left: 50 },
      { top: "64%", right: 15, bottom: 30, left: 50 },
    ];
    const options = createChartOptions({ grid: grids });
    expect(options.grid).toEqual(grids);
  });

  it("preserves component-specific properties not in theme", () => {
    const options = createChartOptions({
      visualMap: { show: false, pieces: [{ lte: 1, color: "red" }] },
      graphic: [{ type: "text", right: 10, top: 5 }],
    });
    expect(options.visualMap).toEqual({ show: false, pieces: [{ lte: 1, color: "red" }] });
    expect(options.graphic).toEqual([{ type: "text", right: 10, top: 5 }]);
  });

  it("does not mutate the CHART_THEME constant", () => {
    const originalBg = CHART_THEME.tooltip.backgroundColor;
    createChartOptions({
      tooltip: { backgroundColor: "#ffffff" },
    });
    expect(CHART_THEME.tooltip.backgroundColor).toBe(originalBg);
  });

  it("allows function formatters in tooltip", () => {
    const formatter = () => "test";
    const options = createChartOptions({
      tooltip: { formatter },
    });
    expect(options.tooltip.formatter).toBe(formatter);
    // Defaults still present
    expect(options.tooltip.backgroundColor).toBe("#18181b");
  });
});
