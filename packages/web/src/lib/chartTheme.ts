/**
 * Shared ECharts theme config for the sage/mint palette.
 *
 * Import `chartTheme` and spread into ECharts option objects
 * to get consistent tooltip, axis, and grid styling.
 */
import { chartThemeColors } from "@dofek/scoring/colors";

/** Reusable tooltip config */
export const tooltip = {
  backgroundColor: chartThemeColors.tooltipBackground,
  borderColor: chartThemeColors.tooltipBorder,
  textStyle: { color: chartThemeColors.tooltipText, fontSize: 12 },
} as const;

/** Reusable axis label config */
export const axisLabel = {
  color: chartThemeColors.axisLabel,
  fontSize: 11,
} as const;

/** Reusable axis line config */
export const axisLine = {
  lineStyle: { color: chartThemeColors.axisLine },
} as const;

/** Reusable split/grid line config */
export const splitLine = {
  lineStyle: { color: chartThemeColors.gridLine },
} as const;

/** Reusable axis name text style */
export const nameTextStyle = {
  color: chartThemeColors.axisLabel,
  fontSize: 11,
} as const;

/** Reusable legend config */
export const legend = {
  textStyle: { color: chartThemeColors.legendText, fontSize: 11 },
} as const;

/** All chart theme pieces bundled */
export const chartTheme = {
  tooltip,
  axisLabel,
  axisLine,
  splitLine,
  nameTextStyle,
  legend,
} as const;

/**
 * Individual color values for inline use (e.g. custom tooltip formatters,
 * SVG stroke attributes, series-specific overrides).
 */
export { chartThemeColors };
