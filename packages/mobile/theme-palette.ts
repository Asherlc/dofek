import { chartColors, statusColors, surfaceColors, textColors } from "@dofek/scoring/colors";

export const lightColors = {
  background: surfaceColors.background,
  surface: surfaceColors.surface,
  card: surfaceColors.surface,
  surfaceSecondary: surfaceColors.surfaceSecondary,
  border: surfaceColors.surfaceSecondary,
  accent: surfaceColors.accent,
  accentSubtle: `${surfaceColors.accent}15`,
  positive: statusColors.positive,
  positiveSubtle: `${statusColors.positive}20`,
  warning: statusColors.warning,
  warningSubtle: `${statusColors.warning}20`,
  danger: statusColors.danger,
  dangerSubtle: `${statusColors.danger}20`,
  negative: statusColors.danger,
  teal: chartColors.teal,
  purple: chartColors.purple,
  blue: chartColors.blue,
  green: chartColors.green,
  orange: chartColors.orange,
  text: textColors.primary,
  textSecondary: textColors.secondary,
  textTertiary: textColors.tertiary,
  textMuted: textColors.tertiary,
  textInverse: "#ffffff",
} as const;

export const darkColors = {
  background: "#0f1712",
  surface: "#18241c",
  card: "#18241c",
  surfaceSecondary: "#25342a",
  border: "#25342a",
  accent: surfaceColors.accent,
  accentSubtle: `${surfaceColors.accent}15`,
  positive: statusColors.positive,
  positiveSubtle: `${statusColors.positive}20`,
  warning: statusColors.warning,
  warningSubtle: `${statusColors.warning}20`,
  danger: statusColors.danger,
  dangerSubtle: `${statusColors.danger}20`,
  negative: statusColors.danger,
  teal: chartColors.teal,
  purple: chartColors.purple,
  blue: chartColors.blue,
  green: chartColors.green,
  orange: chartColors.orange,
  text: "#f1f7f2",
  textSecondary: "#b8c8bc",
  textTertiary: "#8fa395",
  textMuted: "#8fa395",
  textInverse: "#ffffff",
} as const satisfies Record<keyof typeof lightColors, string>;

type ThemeColorRole = keyof typeof lightColors;

export type AdaptiveColorVariants = {
  light: string;
  dark: string;
};

export function createAdaptiveColors<ColorValue>(
  createColor: (variants: AdaptiveColorVariants) => ColorValue,
): Record<ThemeColorRole, ColorValue> {
  const createRole = (role: ThemeColorRole) =>
    createColor({ light: lightColors[role], dark: darkColors[role] });

  return {
    background: createRole("background"),
    surface: createRole("surface"),
    card: createRole("card"),
    surfaceSecondary: createRole("surfaceSecondary"),
    border: createRole("border"),
    accent: createRole("accent"),
    accentSubtle: createRole("accentSubtle"),
    positive: createRole("positive"),
    positiveSubtle: createRole("positiveSubtle"),
    warning: createRole("warning"),
    warningSubtle: createRole("warningSubtle"),
    danger: createRole("danger"),
    dangerSubtle: createRole("dangerSubtle"),
    negative: createRole("negative"),
    teal: createRole("teal"),
    purple: createRole("purple"),
    blue: createRole("blue"),
    green: createRole("green"),
    orange: createRole("orange"),
    text: createRole("text"),
    textSecondary: createRole("textSecondary"),
    textTertiary: createRole("textTertiary"),
    textMuted: createRole("textMuted"),
    textInverse: createRole("textInverse"),
  };
}
