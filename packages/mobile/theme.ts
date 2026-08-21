import {
  chartColors,
  operationalStatusColors,
  statusColors,
  surfaceColors,
  textColors,
} from "@dofek/scoring/colors";
import {
  duration,
  easing,
  fontFamily,
  fontSize,
  fontWeight,
  radius,
  spacing,
} from "@dofek/scoring/tokens";
import { lightColors } from "./theme-palette";

export { chartColors, operationalStatusColors, statusColors, surfaceColors, textColors };
export { duration, easing, fontSize, fontWeight, radius, spacing };

export const fonts = {
  body: fontFamily.body,
  mono: "DMMono",
  bold: fontFamily.body,
} as const;

/** Light fallback used by non-iOS renderers such as React Native Web Storybook. */
export const colors = lightColors;
