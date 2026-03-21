/** Shared ECharts dark theme configuration and factory function. */

// ── Color constants ─────────────────────────────────────────────────
export const TOOLTIP_BG = "#18181b";
export const TOOLTIP_BORDER = "#3f3f46";
export const TOOLTIP_TEXT_COLOR = "#e4e4e7";
export const AXIS_LABEL_COLOR = "#71717a";
export const AXIS_LINE_COLOR = "#3f3f46";
export const SPLIT_LINE_COLOR = "#27272a";
export const LEGEND_TEXT_COLOR = "#a1a1aa";

// ── Default dark theme ──────────────────────────────────────────────
export const CHART_THEME = {
  backgroundColor: "transparent",
  tooltip: {
    backgroundColor: TOOLTIP_BG,
    borderColor: TOOLTIP_BORDER,
    textStyle: { color: TOOLTIP_TEXT_COLOR, fontSize: 12 },
  },
  xAxis: {
    axisLabel: { color: AXIS_LABEL_COLOR, fontSize: 11 },
    axisLine: { lineStyle: { color: AXIS_LINE_COLOR } },
  },
  yAxis: {
    splitLine: { lineStyle: { color: SPLIT_LINE_COLOR } },
    axisLabel: { color: AXIS_LABEL_COLOR, fontSize: 11 },
    nameTextStyle: { color: AXIS_LABEL_COLOR, fontSize: 11 },
  },
  legend: {
    textStyle: { color: LEGEND_TEXT_COLOR, fontSize: 11 },
  },
} satisfies Record<string, unknown>;

// ── Deep merge helper ───────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target };
  for (const key of Object.keys(source)) {
    const targetVal = result[key];
    const sourceVal = source[key];
    if (isPlainObject(targetVal) && isPlainObject(sourceVal)) {
      result[key] = deepMerge(targetVal, sourceVal);
    } else {
      result[key] = sourceVal;
    }
  }
  return result;
}

// ── Section merge helpers ───────────────────────────────────────────

function mergeSection(
  defaultValues: Record<string, unknown>,
  override: unknown,
): Record<string, unknown> | unknown[] {
  if (override === undefined) {
    return deepMerge({}, defaultValues);
  }
  if (Array.isArray(override)) {
    return override;
  }
  if (isPlainObject(override)) {
    return deepMerge(deepMerge({}, defaultValues), override);
  }
  return deepMerge({}, defaultValues);
}

// ── Factory function ────────────────────────────────────────────────

interface ChartOptions {
  backgroundColor: string;
  tooltip: Record<string, unknown>;
  xAxis: Record<string, unknown> | unknown[];
  yAxis: Record<string, unknown> | unknown[];
  legend: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Creates ECharts options by deep-merging overrides onto the shared dark theme.
 *
 * For single-object xAxis/yAxis/legend/tooltip, theme defaults are deep-merged
 * so callers only need to specify what differs. For array forms (multi-axis, multi-grid),
 * the array is passed through as-is since each element may have unique config.
 */
export function createChartOptions(overrides: Record<string, unknown>): ChartOptions {
  const tooltipDefault: Record<string, unknown> = {
    backgroundColor: CHART_THEME.tooltip.backgroundColor,
    borderColor: CHART_THEME.tooltip.borderColor,
    textStyle: { ...CHART_THEME.tooltip.textStyle },
  };
  const xAxisDefault: Record<string, unknown> = {
    axisLabel: { ...CHART_THEME.xAxis.axisLabel },
    axisLine: { lineStyle: { ...CHART_THEME.xAxis.axisLine.lineStyle } },
  };
  const yAxisDefault: Record<string, unknown> = {
    splitLine: { lineStyle: { ...CHART_THEME.yAxis.splitLine.lineStyle } },
    axisLabel: { ...CHART_THEME.yAxis.axisLabel },
    nameTextStyle: { ...CHART_THEME.yAxis.nameTextStyle },
  };
  const legendDefault: Record<string, unknown> = {
    textStyle: { ...CHART_THEME.legend.textStyle },
  };

  const tooltip = mergeSection(tooltipDefault, overrides.tooltip);
  const xAxis = mergeSection(xAxisDefault, overrides.xAxis);
  const yAxis = mergeSection(yAxisDefault, overrides.yAxis);
  const legend = mergeSection(legendDefault, overrides.legend);

  // Build the result with known themed sections
  const result: ChartOptions = {
    backgroundColor: CHART_THEME.backgroundColor,
    tooltip: Array.isArray(tooltip) ? {} : tooltip,
    xAxis,
    yAxis,
    legend: Array.isArray(legend) ? {} : legend,
  };

  // Apply all remaining overrides (series, grid, visualMap, graphic, etc.)
  const themedKeys = new Set(["tooltip", "xAxis", "yAxis", "legend"]);
  for (const key of Object.keys(overrides)) {
    if (themedKeys.has(key)) continue;
    const baseVal = result[key];
    const overrideVal = overrides[key];
    if (isPlainObject(baseVal) && isPlainObject(overrideVal)) {
      result[key] = deepMerge(baseVal, overrideVal);
    } else {
      result[key] = overrideVal;
    }
  }

  return result;
}
