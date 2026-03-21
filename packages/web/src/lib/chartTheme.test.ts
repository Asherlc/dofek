import { chartColors, chartThemeColors } from "@dofek/scoring/colors";
import { chart as chartTokens, duration, easing } from "@dofek/scoring/tokens";
import { describe, expect, it } from "vitest";
import {
  dofekAnimation,
  dofekAxis,
  dofekGrid,
  dofekLegend,
  dofekSeries,
  dofekTooltip,
  seriesColor,
} from "./chartTheme.ts";

describe("dofekTooltip", () => {
  it("returns axis trigger by default", () => {
    const tooltip = dofekTooltip();
    expect(tooltip.trigger).toBe("axis");
  });

  it("applies theme background and border colors", () => {
    const tooltip = dofekTooltip();
    expect(tooltip.backgroundColor).toBe(chartThemeColors.tooltipBackground);
    expect(tooltip.borderColor).toBe(chartThemeColors.tooltipBorder);
  });

  it("applies theme text style", () => {
    const tooltip = dofekTooltip();
    expect(tooltip.textStyle).toEqual({
      color: chartThemeColors.tooltipText,
      fontSize: 12,
    });
  });

  it("merges trigger override", () => {
    const tooltip = dofekTooltip({ trigger: "item" });
    expect(tooltip.trigger).toBe("item");
    // Other defaults preserved
    expect(tooltip.backgroundColor).toBe(chartThemeColors.tooltipBackground);
  });

  it("merges formatter override while preserving defaults", () => {
    const formatter = () => "custom";
    const tooltip = dofekTooltip({ formatter });
    expect(tooltip.formatter).toBe(formatter);
    expect(tooltip.backgroundColor).toBe(chartThemeColors.tooltipBackground);
  });

  it("merges axisPointer override", () => {
    const axisPointer = { type: "shadow" };
    const tooltip = dofekTooltip({ axisPointer });
    expect(tooltip.axisPointer).toEqual({ type: "shadow" });
  });

  it("returns defaults with no arguments", () => {
    const tooltip = dofekTooltip();
    expect(tooltip).toEqual({
      trigger: "axis",
      backgroundColor: chartThemeColors.tooltipBackground,
      borderColor: chartThemeColors.tooltipBorder,
      textStyle: { color: chartThemeColors.tooltipText, fontSize: 12 },
    });
  });

  it("overrides trigger to none", () => {
    const tooltip = dofekTooltip({ trigger: "none" });
    expect(tooltip.trigger).toBe("none");
  });
});

describe("dofekAxis", () => {
  describe("time", () => {
    it("returns time type", () => {
      const axis = dofekAxis.time();
      expect(axis.type).toBe("time");
    });

    it("applies theme axis label styling", () => {
      const axis = dofekAxis.time();
      expect(axis.axisLabel).toEqual({
        color: chartThemeColors.axisLabel,
        fontSize: 11,
      });
    });

    it("applies theme axis line styling", () => {
      const axis = dofekAxis.time();
      expect(axis.axisLine).toEqual({
        lineStyle: { color: chartThemeColors.axisLine },
      });
    });

    it("hides split lines by default", () => {
      const axis = dofekAxis.time();
      expect(axis.splitLine).toEqual({ show: false });
    });

    it("passes through show option", () => {
      const axis = dofekAxis.time({ show: false });
      expect(axis.show).toBe(false);
    });

    it("merges axisLabel overrides", () => {
      const axis = dofekAxis.time({ axisLabel: { rotate: 45 } });
      expect(axis.axisLabel).toEqual({
        color: chartThemeColors.axisLabel,
        fontSize: 11,
        rotate: 45,
      });
    });

    it("returns show as undefined when not provided", () => {
      const axis = dofekAxis.time();
      expect(axis.show).toBeUndefined();
    });
  });

  describe("category", () => {
    it("returns category type", () => {
      const axis = dofekAxis.category();
      expect(axis.type).toBe("category");
    });

    it("passes through data option", () => {
      const axis = dofekAxis.category({ data: ["Mon", "Tue", "Wed"] });
      expect(axis.data).toEqual(["Mon", "Tue", "Wed"]);
    });

    it("applies theme axis label styling", () => {
      const axis = dofekAxis.category();
      expect(axis.axisLabel).toEqual({
        color: chartThemeColors.axisLabel,
        fontSize: 11,
      });
    });

    it("applies theme axis line styling", () => {
      const axis = dofekAxis.category();
      expect(axis.axisLine).toEqual({
        lineStyle: { color: chartThemeColors.axisLine },
      });
    });

    it("hides split lines", () => {
      const axis = dofekAxis.category();
      expect(axis.splitLine).toEqual({ show: false });
    });

    it("returns undefined data when not provided", () => {
      const axis = dofekAxis.category();
      expect(axis.data).toBeUndefined();
    });

    it("passes through show option", () => {
      const axis = dofekAxis.category({ show: false });
      expect(axis.show).toBe(false);
    });

    it("merges axisLabel overrides", () => {
      const axis = dofekAxis.category({ axisLabel: { interval: 0 } });
      expect(axis.axisLabel).toEqual({
        color: chartThemeColors.axisLabel,
        fontSize: 11,
        interval: 0,
      });
    });
  });

  describe("value", () => {
    it("returns value type by default", () => {
      const axis = dofekAxis.value();
      expect(axis.type).toBe("value");
    });

    it("positions on left by default", () => {
      const axis = dofekAxis.value();
      expect(axis.position).toBe("left");
    });

    it("shows split line with theme color by default", () => {
      const axis = dofekAxis.value();
      expect(axis.splitLine).toEqual({
        lineStyle: { color: chartThemeColors.gridLine },
      });
    });

    it("hides split line when showSplitLine is false", () => {
      const axis = dofekAxis.value({ showSplitLine: false });
      expect(axis.splitLine).toEqual({ show: false });
    });

    it("passes through name, min, and max options", () => {
      const axis = dofekAxis.value({ name: "bpm", min: 40, max: 200 });
      expect(axis.name).toBe("bpm");
      expect(axis.min).toBe(40);
      expect(axis.max).toBe(200);
    });

    it("accepts position override", () => {
      const axis = dofekAxis.value({ position: "right" });
      expect(axis.position).toBe("right");
    });

    it("supports log type", () => {
      const axis = dofekAxis.value({ type: "log", logBase: 10 });
      expect(axis.type).toBe("log");
      expect(axis.logBase).toBe(10);
    });

    it("supports dataMin and dataMax", () => {
      const axis = dofekAxis.value({ min: "dataMin", max: "dataMax" });
      expect(axis.min).toBe("dataMin");
      expect(axis.max).toBe("dataMax");
    });

    it("applies theme axis label styling", () => {
      const axis = dofekAxis.value();
      expect(axis.axisLabel).toEqual({
        color: chartThemeColors.axisLabel,
        fontSize: 11,
      });
    });

    it("shows axis line with theme color", () => {
      const axis = dofekAxis.value();
      expect(axis.axisLine).toEqual({
        show: true,
        lineStyle: { color: chartThemeColors.axisLine },
      });
    });

    it("applies theme name text style", () => {
      const axis = dofekAxis.value();
      expect(axis.nameTextStyle).toEqual({
        color: chartThemeColors.axisLabel,
        fontSize: 11,
      });
    });

    it("merges axisLabel overrides", () => {
      const axis = dofekAxis.value({ axisLabel: { formatter: "{value} W" } });
      expect(axis.axisLabel).toEqual({
        color: chartThemeColors.axisLabel,
        fontSize: 11,
        formatter: "{value} W",
      });
    });

    it("returns undefined for unset options", () => {
      const axis = dofekAxis.value();
      expect(axis.name).toBeUndefined();
      expect(axis.min).toBeUndefined();
      expect(axis.max).toBeUndefined();
      expect(axis.logBase).toBeUndefined();
    });
  });
});

describe("dofekGrid", () => {
  it("returns standard grid padding by default", () => {
    const grid = dofekGrid();
    expect(grid).toEqual(chartTokens.grid);
  });

  it("returns standard grid for single variant", () => {
    const grid = dofekGrid("single");
    expect(grid).toEqual(chartTokens.grid);
  });

  it("returns dual-axis grid padding for dualAxis variant", () => {
    const grid = dofekGrid("dualAxis");
    expect(grid).toEqual(chartTokens.gridDualAxis);
  });

  it("dualAxis has more right padding than single", () => {
    const single = dofekGrid("single");
    const dual = dofekGrid("dualAxis");
    expect(dual.right).toBeGreaterThan(single.right);
  });

  it("merges overrides on top of single grid", () => {
    const grid = dofekGrid("single", { top: 50, left: 60 });
    expect(grid.top).toBe(50);
    expect(grid.left).toBe(60);
    // Non-overridden values from standard grid
    expect(grid.right).toBe(chartTokens.grid.right);
    expect(grid.bottom).toBe(chartTokens.grid.bottom);
  });

  it("merges overrides on top of dualAxis grid", () => {
    const grid = dofekGrid("dualAxis", { bottom: 50 });
    expect(grid.bottom).toBe(50);
    expect(grid.right).toBe(chartTokens.gridDualAxis.right);
  });

  it("does not mutate the chart tokens", () => {
    const originalGrid = { ...chartTokens.grid };
    dofekGrid("single", { top: 999 });
    expect(chartTokens.grid).toEqual(originalGrid);
  });
});

describe("dofekLegend", () => {
  it("returns show true when passed true", () => {
    const legend = dofekLegend(true);
    expect(legend.show).toBe(true);
  });

  it("returns show false when passed false", () => {
    const legend = dofekLegend(false);
    expect(legend.show).toBe(false);
  });

  it("applies theme text style", () => {
    const legend = dofekLegend(true);
    expect(legend.textStyle).toEqual({
      color: chartThemeColors.legendText,
      fontSize: 11,
    });
  });

  it("positions at top by default", () => {
    const legend = dofekLegend(true);
    expect(legend.top).toBe(0);
  });

  it("merges overrides", () => {
    const legend = dofekLegend(true, { top: 10, type: "scroll" });
    expect(legend.top).toBe(10);
    expect(legend.type).toBe("scroll");
  });

  it("merges data override", () => {
    const legend = dofekLegend(true, { data: ["HR", "Pace"] });
    expect(legend.data).toEqual(["HR", "Pace"]);
  });

  it("preserves theme text style when overrides are applied", () => {
    const legend = dofekLegend(false, { top: 20 });
    expect(legend.textStyle).toEqual({
      color: chartThemeColors.legendText,
      fontSize: 11,
    });
  });
});

describe("dofekSeries", () => {
  describe("line", () => {
    it("returns line type series", () => {
      const series = dofekSeries.line("HR", [[1, 80]]);
      expect(series.type).toBe("line");
      expect(series.name).toBe("HR");
      expect(series.data).toEqual([[1, 80]]);
    });

    it("defaults to smooth lines", () => {
      const series = dofekSeries.line("HR", []);
      expect(series.smooth).toBe(true);
    });

    it("defaults to no symbol", () => {
      const series = dofekSeries.line("HR", []);
      expect(series.symbol).toBe("none");
    });

    it("defaults to line width 2", () => {
      const series = dofekSeries.line("HR", []);
      expect(series.lineStyle.width).toBe(2);
    });

    it("defaults to yAxisIndex 0", () => {
      const series = dofekSeries.line("HR", []);
      expect(series.yAxisIndex).toBe(0);
    });

    it("applies color to lineStyle and itemStyle", () => {
      const series = dofekSeries.line("HR", [], { color: "#ff0000" });
      expect(series.lineStyle.color).toBe("#ff0000");
      expect(series.itemStyle.color).toBe("#ff0000");
    });

    it("supports smooth override as false", () => {
      const series = dofekSeries.line("HR", [], { smooth: false });
      expect(series.smooth).toBe(false);
    });

    it("supports smooth as numeric tension", () => {
      const series = dofekSeries.line("HR", [], { smooth: 0.5 });
      expect(series.smooth).toBe(0.5);
    });

    it("supports custom line width", () => {
      const series = dofekSeries.line("HR", [], { width: 3 });
      expect(series.lineStyle.width).toBe(3);
    });

    it("converts boolean areaStyle true to opacity object", () => {
      const series = dofekSeries.line("HR", [], { areaStyle: true });
      expect(series.areaStyle).toEqual({ opacity: 0.15 });
    });

    it("passes through object areaStyle", () => {
      const series = dofekSeries.line("HR", [], {
        areaStyle: { opacity: 0.3 },
      });
      expect(series.areaStyle).toEqual({ opacity: 0.3 });
    });

    it("returns undefined areaStyle when not specified", () => {
      const series = dofekSeries.line("HR", []);
      expect(series.areaStyle).toBeUndefined();
    });

    it("returns undefined areaStyle when false", () => {
      const series = dofekSeries.line("HR", [], { areaStyle: false });
      expect(series.areaStyle).toBeUndefined();
    });

    it("supports yAxisIndex override", () => {
      const series = dofekSeries.line("HR", [], { yAxisIndex: 1 });
      expect(series.yAxisIndex).toBe(1);
    });

    it("supports stack option", () => {
      const series = dofekSeries.line("HR", [], { stack: "total" });
      expect(series.stack).toBe("total");
    });

    it("supports symbol and symbolSize overrides", () => {
      const series = dofekSeries.line("HR", [], {
        symbol: "circle",
        symbolSize: 8,
      });
      expect(series.symbol).toBe("circle");
      expect(series.symbolSize).toBe(8);
    });

    it("supports lineStyle override", () => {
      const series = dofekSeries.line("HR", [], {
        lineStyle: { type: "dashed" },
      });
      expect(series.lineStyle).toHaveProperty("type", "dashed");
    });

    it("supports z option", () => {
      const series = dofekSeries.line("HR", [], { z: 10 });
      expect(series.z).toBe(10);
    });
  });

  describe("bar", () => {
    it("returns bar type series", () => {
      const series = dofekSeries.bar("Volume", [10, 20, 30]);
      expect(series.type).toBe("bar");
      expect(series.name).toBe("Volume");
      expect(series.data).toEqual([10, 20, 30]);
    });

    it("defaults to yAxisIndex 0", () => {
      const series = dofekSeries.bar("Volume", []);
      expect(series.yAxisIndex).toBe(0);
    });

    it("applies color to itemStyle", () => {
      const series = dofekSeries.bar("Volume", [], { color: "#00ff00" });
      expect(series.itemStyle.color).toBe("#00ff00");
    });

    it("supports stack option", () => {
      const series = dofekSeries.bar("Volume", [], { stack: "total" });
      expect(series.stack).toBe("total");
    });

    it("supports barWidth and barGap", () => {
      const series = dofekSeries.bar("Volume", [], {
        barWidth: "60%",
        barGap: "10%",
      });
      expect(series.barWidth).toBe("60%");
      expect(series.barGap).toBe("10%");
    });

    it("merges itemStyle override with color", () => {
      const series = dofekSeries.bar("Volume", [], {
        color: "#ff0000",
        itemStyle: { borderRadius: [4, 4, 0, 0] },
      });
      expect(series.itemStyle.color).toBe("#ff0000");
      expect(series.itemStyle).toHaveProperty("borderRadius", [4, 4, 0, 0]);
    });

    it("supports yAxisIndex override", () => {
      const series = dofekSeries.bar("Volume", [], { yAxisIndex: 1 });
      expect(series.yAxisIndex).toBe(1);
    });

    it("returns undefined for unset optional fields", () => {
      const series = dofekSeries.bar("Volume", []);
      expect(series.stack).toBeUndefined();
      expect(series.barWidth).toBeUndefined();
      expect(series.barGap).toBeUndefined();
    });
  });

  describe("scatter", () => {
    it("returns scatter type series", () => {
      const series = dofekSeries.scatter("Points", [[1, 2]]);
      expect(series.type).toBe("scatter");
      expect(series.name).toBe("Points");
      expect(series.data).toEqual([[1, 2]]);
    });

    it("defaults to symbolSize 5", () => {
      const series = dofekSeries.scatter("Points", []);
      expect(series.symbolSize).toBe(5);
    });

    it("defaults to opacity 0.7", () => {
      const series = dofekSeries.scatter("Points", []);
      expect(series.itemStyle.opacity).toBe(0.7);
    });

    it("defaults to yAxisIndex 0", () => {
      const series = dofekSeries.scatter("Points", []);
      expect(series.yAxisIndex).toBe(0);
    });

    it("applies color to itemStyle", () => {
      const series = dofekSeries.scatter("Points", [], { color: "#0000ff" });
      expect(series.itemStyle.color).toBe("#0000ff");
    });

    it("supports symbolSize override", () => {
      const series = dofekSeries.scatter("Points", [], { symbolSize: 10 });
      expect(series.symbolSize).toBe(10);
    });

    it("supports yAxisIndex override", () => {
      const series = dofekSeries.scatter("Points", [], { yAxisIndex: 1 });
      expect(series.yAxisIndex).toBe(1);
    });

    it("merges itemStyle override while preserving opacity", () => {
      const series = dofekSeries.scatter("Points", [], {
        itemStyle: { borderWidth: 1 },
      });
      expect(series.itemStyle.opacity).toBe(0.7);
      expect(series.itemStyle).toHaveProperty("borderWidth", 1);
    });

    it("allows opacity override via itemStyle", () => {
      const series = dofekSeries.scatter("Points", [], {
        itemStyle: { opacity: 1.0 },
      });
      expect(series.itemStyle.opacity).toBe(1.0);
    });
  });
});

describe("dofekAnimation", () => {
  it("uses chart duration from tokens", () => {
    expect(dofekAnimation.animationDuration).toBe(duration.chart);
  });

  it("uses ECharts easing from tokens", () => {
    expect(dofekAnimation.animationEasing).toBe(easing.echartsOut);
  });

  it("has a stagger delay function", () => {
    expect(typeof dofekAnimation.animationDelay).toBe("function");
  });

  it("stagger delay returns idx * barStaggerDelay", () => {
    expect(dofekAnimation.animationDelay(0)).toBe(0);
    expect(dofekAnimation.animationDelay(1)).toBe(chartTokens.barStaggerDelay);
    expect(dofekAnimation.animationDelay(5)).toBe(5 * chartTokens.barStaggerDelay);
  });
});

describe("seriesColor", () => {
  it("returns teal for index 0", () => {
    expect(seriesColor(0)).toBe(chartColors.teal);
  });

  it("returns purple for index 1", () => {
    expect(seriesColor(1)).toBe(chartColors.purple);
  });

  it("returns blue for index 2", () => {
    expect(seriesColor(2)).toBe(chartColors.blue);
  });

  it("cycles through 8 palette colors", () => {
    // Index 8 should wrap back to teal
    expect(seriesColor(8)).toBe(chartColors.teal);
    expect(seriesColor(9)).toBe(chartColors.purple);
  });

  it("returns a non-empty string for every index", () => {
    for (let i = 0; i < 20; i++) {
      const color = seriesColor(i);
      expect(typeof color).toBe("string");
      expect(color.length).toBeGreaterThan(0);
    }
  });

  it("all palette colors are valid hex codes", () => {
    for (let i = 0; i < 8; i++) {
      expect(seriesColor(i)).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });
});
