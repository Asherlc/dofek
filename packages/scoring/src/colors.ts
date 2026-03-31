/**
 * Semantic color palette shared across web and iOS.
 *
 * Web components use these in ECharts config and inline styles.
 * iOS components use these directly in React Native StyleSheets.
 * Tailwind utility classes remain platform-specific (web only).
 */

/** Status colors for scores, alerts, and thresholds.
 *  Darkened one shade vs originals for contrast on light sage background. */
export const statusColors = {
  /** Positive / good / green — scores ≥67, optimal zones */
  positive: "#16a34a",
  /** Warning / moderate / yellow — scores 34-66, caution zones */
  warning: "#ca8a04",
  /** Danger / poor / red — scores <34, injury risk */
  danger: "#dc2626",
  /** Informational / neutral / blue */
  info: "#2563eb",
  /** Orange — elevated warnings (e.g. high ramp rate) */
  elevated: "#ea580c",
} as const;

/** Chart series colors for consistent multi-series plots.
 *  Adjusted for contrast on light (#eef3ed) background. */
export const chartColors = {
  teal: "#0ea5e9",
  purple: "#5E35B1",
  blue: "#2563eb",
  green: "#16a34a",
  orange: "#ea580c",
  emerald: "#059669",
  pink: "#db2777",
  amber: "#d97706",
} as const;

/** Light sage/mint theme surface colors */
export const surfaceColors = {
  background: "#eef3ed",
  surface: "#f5f9f5",
  surfaceSecondary: "#e8ede7",
  accent: "#2d7a56",
} as const;

/** Text colors for sage/mint light theme */
export const textColors = {
  primary: "#1a2e1a",
  secondary: "#4a6a4a",
  tertiary: "#6b8a6b",
  /** Neutral gray — used for stable/unchanged trends */
  neutral: "#8aaa8a",
} as const;

/** Sleep stage colors — consistent across web (ECharts) and mobile (SVG).
 *  Uses the Material-inspired palette for maximum stage distinction. */
export const sleepStageColors = {
  deep: "#5E35B1",
  rem: "#42A5F5",
  light: "#78909C",
  awake: "#FF8A65",
} as const;

/** Activity metric chart series colors — universal associations. */
export const activityMetricColors = {
  heartRate: "#dc2626",
  power: "#d97706",
  speed: "#2563eb",
  cadence: "#5E35B1",
} as const;

/** Chart chrome colors for ECharts tooltips, axes, and grid lines */
export const chartThemeColors = {
  gridLine: "rgba(74, 158, 122, 0.12)",
  axisLine: "rgba(74, 158, 122, 0.25)",
  axisLabel: "#6b8a6b",
  tooltipBackground: "#ffffff",
  tooltipBorder: "rgba(74, 158, 122, 0.2)",
  tooltipText: "#1a2e1a",
  legendText: "#4a6a4a",
} as const;
