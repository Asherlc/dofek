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
import { DynamicColorIOS } from "react-native";
import { createAdaptiveColors } from "./theme-palette";

export { chartColors, operationalStatusColors, statusColors, surfaceColors, textColors };
export { duration, easing, fontSize, fontWeight, radius, spacing };

export const fonts = {
  body: fontFamily.body,
  mono: "DMMono",
  bold: fontFamily.body,
} as const;

/**
 * Native colors resolve against the current iOS appearance even when they are
 * captured in a static StyleSheet.
 *
 * @see https://reactnative.dev/docs/dynamiccolorios
 */
export const colors = createAdaptiveColors(DynamicColorIOS);
