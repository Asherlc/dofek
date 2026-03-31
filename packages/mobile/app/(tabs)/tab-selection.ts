import { colors } from "../../theme";

const tabIconNames = {
  index: { focused: "today", unfocused: "today-outline" },
  recovery: { focused: "pulse", unfocused: "pulse-outline" },
  strain: { focused: "barbell", unfocused: "barbell-outline" },
  food: { focused: "nutrition", unfocused: "nutrition-outline" },
} as const;

export type TabRouteName = keyof typeof tabIconNames;

export function getTabIconName(routeName: TabRouteName, focused: boolean) {
  const iconNames = tabIconNames[routeName];
  return focused ? iconNames.focused : iconNames.unfocused;
}

export const selectedTabBackgroundColor = colors.surfaceSecondary;
