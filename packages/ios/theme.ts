/**
 * Shared color palette for the dark Whoop-style UI.
 *
 * Re-exported from @dofek/scoring — this module composes the shared semantic
 * color tokens into the flat `colors` object that iOS components expect.
 */
import { chartColors, statusColors, surfaceColors, textColors } from "@dofek/scoring/colors";

export { chartColors, statusColors, surfaceColors, textColors };

export const colors = {
  /** Pure black background */
  background: surfaceColors.background,
  /** Elevated surface (cards) */
  surface: surfaceColors.surface,
  /** Subtle divider / secondary surface */
  surfaceSecondary: surfaceColors.surfaceSecondary,
  /** Primary accent (links, buttons) */
  accent: surfaceColors.accent,

  /** Positive / good / green */
  positive: statusColors.positive,
  /** Warning / moderate / yellow */
  warning: statusColors.warning,
  /** Danger / poor / red */
  danger: statusColors.danger,

  /** Light teal accent */
  teal: chartColors.teal,
  /** Deep purple accent */
  purple: chartColors.purple,
  /** Blue accent */
  blue: chartColors.blue,
  /** Green accent */
  green: chartColors.green,
  /** Orange accent */
  orange: chartColors.orange,

  /** Primary text */
  text: textColors.primary,
  /** Secondary text / labels */
  textSecondary: textColors.secondary,
  /** Tertiary text / dimmed */
  textTertiary: textColors.tertiary,
} as const;
