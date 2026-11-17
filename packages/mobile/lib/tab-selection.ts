import { colors } from "../theme";

const tabIconNames = {
  index: { focused: "home", unfocused: "home-outline" },
  training: { focused: "barbell", unfocused: "barbell-outline" },
  activities: { focused: "map", unfocused: "map-outline" },
  "sleep-overview": { focused: "moon", unfocused: "moon-outline" },
  more: { focused: "ellipsis-horizontal-circle", unfocused: "ellipsis-horizontal" },
} as const;

export type TabRouteName = keyof typeof tabIconNames;

export function getTabIconName(routeName: TabRouteName, focused: boolean) {
  const iconNames = tabIconNames[routeName];
  return focused ? iconNames.focused : iconNames.unfocused;
}

export const selectedTabBackgroundColor = colors.accentSubtle;
