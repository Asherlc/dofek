/**
 * Shared color palette for the sage/mint light UI.
 *
 * Re-exported from @dofek/scoring — this module composes the shared semantic
 * color tokens into the flat `colors` object that iOS components expect.
 */
import { chartColors, statusColors, surfaceColors, textColors } from "@dofek/scoring/colors";
import {
  duration,
  easing,
  fontFamily,
  fontSize,
  fontWeight,
  radius,
  spacing,
} from "@dofek/scoring/tokens";

export { chartColors, statusColors, surfaceColors, textColors };
export { duration, easing, fontSize, fontWeight, radius, spacing };

/** Font families — maps shared token names to platform-specific names */
export const fonts = {
  body: fontFamily.body,
  /** DM Mono ships as "DMMono" in Expo font assets (no space in filename) */
  mono: "DMMono",
} as const;

export const colors = {
  /** Light sage background */
  background: surfaceColors.background,
  /** Elevated surface (cards) — opaque equivalent for RN (no backdrop-filter) */
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
