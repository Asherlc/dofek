import { colors } from "../theme";

const tabIconNames = {
  index: { focused: "home", unfocused: "home-outline" },
  training: { focused: "barbell", unfocused: "barbell-outline" },
  activities: { focused: "map", unfocused: "map-outline" },
  "sleep-overview": { focused: "moon", unfocused: "moon-outline" },
  more: { focused: "ellipsis-horizontal-circle", unfocused: "ellipsis-horizontal" },
} as const;

export type TabRouteName = keyof typeof tabIconNames;

export const primaryTabs = [
  { name: "index", title: "Overview" },
  { name: "training", title: "Training" },
  { name: "activities", title: "Activities" },
  { name: "sleep-overview", title: "Sleep" },
  { name: "more", title: "More" },
] as const satisfies ReadonlyArray<{ name: TabRouteName; title: string }>;

export function getTabIconName(routeName: TabRouteName, focused: boolean) {
  const iconNames = tabIconNames[routeName];
  return focused ? iconNames.focused : iconNames.unfocused;
}

export const selectedTabBackgroundColor = colors.accentSubtle;
