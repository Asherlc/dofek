/**
 * Composable ECharts configuration system for Dofek.
 *
 * Instead of repeating tooltip/axis/grid config in every chart component,
 * use these builders to assemble consistent ECharts options.
 *
 * Usage:
 *   import { dofekTooltip, dofekAxis, dofekGrid, dofekLegend } from "../lib/chartTheme.ts";
 *
 *   const option = {
 *     backgroundColor: "transparent",
 *     tooltip: dofekTooltip(),
 *     xAxis: dofekAxis.time(),
 *     yAxis: dofekAxis.value({ name: "bpm" }),
 *     grid: dofekGrid(),
 *     legend: dofekLegend(series.length > 1),
 *     series: [dofekSeries.line("HR", data, { color: chartColors.teal })],
 *   };
 */
import { chartColors, chartThemeColors } from "@dofek/scoring/colors";
import { chart as chartTokens, duration, easing } from "@dofek/scoring/tokens";

// Re-export for inline use in custom formatters
export { chartThemeColors, chartColors };

// ── Tooltip ──

interface TooltipOverrides {
  trigger?: "axis" | "item" | "none";
  formatter?: unknown;
  axisPointer?: unknown;
}

/** Standard Dofek tooltip. Override trigger or add a custom formatter. */
export function dofekTooltip(overrides?: TooltipOverrides) {
  return {
    trigger: "axis" as const,
    backgroundColor: chartThemeColors.tooltipBackground,
    borderColor: chartThemeColors.tooltipBorder,
    textStyle: { color: chartThemeColors.tooltipText, fontSize: 12 },
    ...overrides,
  };
}

// ── Axes ──

interface ValueAxisOptions {
  name?: string;
  min?: number | "dataMin";
  max?: number | "dataMax";
  position?: "left" | "right";
  showSplitLine?: boolean;
  type?: "value" | "log";
  logBase?: number;
  axisLabel?: Record<string, unknown>;
}

interface TimeAxisOptions {
  show?: boolean;
  axisLabel?: Record<string, unknown>;
}

interface CategoryAxisOptions {
  data?: string[];
  show?: boolean;
  axisLabel?: Record<string, unknown>;
}

export const dofekAxis = {
  /** Time x-axis (most common for daily metrics) */
  time(options?: TimeAxisOptions) {
    return {
      type: "time" as const,
      axisLabel: { color: chartThemeColors.axisLabel, fontSize: 11, ...options?.axisLabel },
      axisLine: { lineStyle: { color: chartThemeColors.axisLine } },
      splitLine: { show: false },
      show: options?.show,
    };
  },

  /** Category x-axis (for bar charts, labels) */
  category(options?: CategoryAxisOptions) {
    return {
      type: "category" as const,
      data: options?.data,
      axisLabel: { color: chartThemeColors.axisLabel, fontSize: 11, ...options?.axisLabel },
      axisLine: { lineStyle: { color: chartThemeColors.axisLine } },
      splitLine: { show: false },
      show: options?.show,
    };
  },

  /** Value y-axis */
  value(options?: ValueAxisOptions) {
    return {
      type: options?.type ?? ("value" satisfies string),
      logBase: options?.logBase,
      name: options?.name,
      min: options?.min,
      max: options?.max,
      position: options?.position ?? "left",
      splitLine:
        options?.showSplitLine === false
          ? { show: false }
          : { lineStyle: { color: chartThemeColors.gridLine } },
      axisLabel: { color: chartThemeColors.axisLabel, fontSize: 11, ...options?.axisLabel },
      axisLine: { show: true, lineStyle: { color: chartThemeColors.axisLine } },
      nameTextStyle: { color: chartThemeColors.axisLabel, fontSize: 11 },
    };
  },
};

// ── Grid ──

interface GridOverrides {
  top?: number;
  right?: number;
  bottom?: number;
  left?: number;
  containLabel?: boolean;
}

/** Standard chart grid. Pass 'dualAxis' to add right margin for a second y-axis. */
export function dofekGrid(variant?: "single" | "dualAxis", overrides?: GridOverrides) {
  const base = variant === "dualAxis" ? { ...chartTokens.gridDualAxis } : { ...chartTokens.grid };
  return { ...base, ...overrides };
}

// ── Legend ──

interface LegendOverrides {
  top?: number | string;
  type?: "plain" | "scroll";
  data?: string[];
}

/** Standard legend. Pass false to hide. */
export function dofekLegend(show: boolean, overrides?: LegendOverrides) {
  return {
    show,
    textStyle: { color: chartThemeColors.legendText, fontSize: 11 },
    top: 0,
    ...overrides,
  };
}

// ── Series builders ──

interface LineOptions {
  color?: string;
  /** true for default smooth, false for sharp, or a number 0-1 for tension */
  smooth?: boolean | number;
  width?: number;
  areaStyle?: boolean | { opacity?: number; color?: unknown };
  yAxisIndex?: number;
  symbol?: string;
  symbolSize?: number;
  stack?: string;
  lineStyle?: Record<string, unknown>;
  z?: number;
}

interface BarOptions {
  color?: string;
  stack?: string;
  yAxisIndex?: number;
  barWidth?: string | number;
  barGap?: string;
  itemStyle?: Record<string, unknown>;
}

interface ScatterOptions {
  color?: string;
  symbolSize?: number;
  yAxisIndex?: number;
  itemStyle?: Record<string, unknown>;
}

export const dofekSeries = {
  /** Line series with standard styling */
  line(name: string, data: unknown[], options?: LineOptions) {
    const area =
      options?.areaStyle === true
        ? { opacity: 0.15 }
        : typeof options?.areaStyle === "object"
          ? options.areaStyle
          : undefined;

    return {
      name,
      type: "line" as const,
      data,
      smooth: options?.smooth ?? true,
      symbol: options?.symbol ?? "none",
      symbolSize: options?.symbolSize,
      lineStyle: { width: options?.width ?? 2, color: options?.color, ...options?.lineStyle },
      itemStyle: { color: options?.color },
      areaStyle: area,
      yAxisIndex: options?.yAxisIndex ?? 0,
      stack: options?.stack,
      z: options?.z,
    };
  },

  /** Bar series */
  bar(name: string, data: unknown[], options?: BarOptions) {
    return {
      name,
      type: "bar" as const,
      data,
      stack: options?.stack,
      yAxisIndex: options?.yAxisIndex ?? 0,
      barWidth: options?.barWidth,
      barGap: options?.barGap,
      itemStyle: { color: options?.color, ...options?.itemStyle },
    };
  },

  /** Scatter series */
  scatter(name: string, data: unknown[], options?: ScatterOptions) {
    return {
      name,
      type: "scatter" as const,
      data,
      symbolSize: options?.symbolSize ?? 5,
      itemStyle: { color: options?.color, opacity: 0.7, ...options?.itemStyle },
      yAxisIndex: options?.yAxisIndex ?? 0,
    };
  },
};

// ── Animation defaults ──

/** Standard animation config to spread into ECharts options */
export const dofekAnimation = {
  animationDuration: duration.chart,
  animationEasing: easing.echartsOut,
  animationDelay: (idx: number) => idx * chartTokens.barStaggerDelay,
} as const;

// ── Color palette ──

const SERIES_PALETTE = [
  chartColors.teal,
  chartColors.purple,
  chartColors.blue,
  chartColors.green,
  chartColors.orange,
  chartColors.emerald,
  chartColors.pink,
  chartColors.amber,
] as const;

/** Get a series color by index, cycling through the palette */
export function seriesColor(index: number): string {
  return SERIES_PALETTE[index % SERIES_PALETTE.length] ?? SERIES_PALETTE[0];
}
