/**
 * Semantic color palette shared across web and iOS.
 *
 * Web components use these in ECharts config and inline styles.
 * iOS components use these directly in React Native StyleSheets.
 * Tailwind utility classes remain platform-specific (web only).
 */

/** Status colors for scores, alerts, and thresholds */
export const statusColors = {
  /** Positive / good / green — scores ≥67, optimal zones */
  positive: "#22c55e",
  /** Warning / moderate / yellow — scores 34-66, caution zones */
  warning: "#eab308",
  /** Danger / poor / red — scores <34, injury risk */
  danger: "#ef4444",
  /** Informational / neutral / blue */
  info: "#3b82f6",
  /** Orange — elevated warnings (e.g. high ramp rate) */
  elevated: "#f97316",
} as const;

/** Chart series colors for consistent multi-series plots */
export const chartColors = {
  teal: "#5AC8FA",
  purple: "#5E35B1",
  blue: "#42A5F5",
  green: "#34C759",
  orange: "#FF8A65",
  emerald: "#10b981",
  pink: "#ec4899",
  amber: "#f59e0b",
} as const;

/** iOS-specific dark theme surface colors (not used in web Tailwind) */
export const surfaceColors = {
  background: "#000",
  surface: "#1c1c1e",
  surfaceSecondary: "#2a2a2e",
  accent: "#007AFF",
} as const;

/** Text colors for dark theme */
export const textColors = {
  primary: "#fff",
  secondary: "#8e8e93",
  tertiary: "#636366",
  /** Neutral gray — used for stable/unchanged trends */
  neutral: "#71717a",
} as const;
