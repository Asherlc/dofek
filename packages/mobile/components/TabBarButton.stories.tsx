import { Ionicons } from "@expo/vector-icons";
import type { Meta, StoryObj } from "@storybook/react-native";
import { DefaultTheme, ThemeProvider } from "expo-router/react-navigation";
import { useState } from "react";
import { Text, View } from "react-native";
import { tabsScreenOptions } from "../app/(tabs)/_layout";
import { getTabIconName, type TabRouteName } from "../lib/tab-selection";
import { colors } from "../theme";
import { TabBarButton } from "./TabBarButton";

const navigatorButtonStyle = {
  flex: 1,
  alignItems: "center",
  flexDirection: "column",
  justifyContent: "flex-start",
  padding: 5,
  borderRadius: 0,
} as const;

const meta = {
  title: "Navigation/TabBarButton",
  component: TabBarButton,
  args: {
    role: "button",
    "aria-label": "Today",
    "aria-selected": true,
    pressOpacity: 1,
    style: [navigatorButtonStyle, { backgroundColor: colors.accentSubtle }],
    children: (
      <>
        <View style={{ height: 28, justifyContent: "center" }}>
          <Ionicons name="today" size={25} style={{ color: colors.accent }} />
        </View>
        <Text style={{ fontSize: 10, fontWeight: "600", color: colors.accent }}>Today</Text>
      </>
    ),
  },
  decorators: [
    (Story, context) => (
      <ThemeProvider value={DefaultTheme}>
        <View
          style={
            context.parameters.layout === "fullscreen"
              ? { width: "100%" }
              : { width: 80, height: 49 }
          }
        >
          <Story />
        </View>
      </ThemeProvider>
    ),
  ],
} satisfies Meta<typeof TabBarButton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Selected: Story = {};

export const Unselected: Story = {
  args: {
    "aria-selected": false,
    style: navigatorButtonStyle,
    children: (
      <>
        <View style={{ height: 28, justifyContent: "center" }}>
          <Ionicons name="today-outline" size={25} style={{ color: colors.textSecondary }} />
        </View>
        <Text style={{ fontSize: 10, fontWeight: "600", color: colors.textSecondary }}>Today</Text>
      </>
    ),
  },
};

const tabItems: { name: TabRouteName; label: string }[] = [
  { name: "index", label: "Today" },
  { name: "recovery", label: "Recovery" },
  { name: "strain", label: "Training" },
  { name: "activities", label: "Activities" },
  { name: "food", label: "Nutrition" },
];

function NavigationPreview({ horizontal = false }: { horizontal?: boolean }) {
  const [selectedTab, setSelectedTab] = useState<TabRouteName>("index");

  return (
    <View style={{ width: "100%", maxWidth: horizontal ? 740 : 390 }}>
      <View
        style={[
          tabsScreenOptions.tabBarStyle,
          { height: horizontal ? 32 : 49, flexDirection: "row" },
        ]}
      >
        {tabItems.map(({ name, label }) => {
          const focused = selectedTab === name;
          const color = focused ? colors.accent : colors.textSecondary;
          return (
            <View key={name} style={[{ flex: 1 }, tabsScreenOptions.tabBarItemStyle]}>
              <TabBarButton
                role="button"
                aria-label={label}
                aria-selected={focused}
                pressOpacity={1}
                onPress={() => setSelectedTab(name)}
                style={[
                  navigatorButtonStyle,
                  {
                    backgroundColor: focused
                      ? tabsScreenOptions.tabBarActiveBackgroundColor
                      : "transparent",
                  },
                  horizontal && { flexDirection: "row" },
                ]}
              >
                <View style={{ height: horizontal ? 20 : 28, justifyContent: "center" }}>
                  <Ionicons
                    name={getTabIconName(name, focused)}
                    size={horizontal ? 18 : 25}
                    style={{ color }}
                  />
                </View>
                <Text
                  style={[
                    tabsScreenOptions.tabBarLabelStyle,
                    { color, fontSize: horizontal ? 12 : 10 },
                    horizontal && { marginLeft: 5, lineHeight: 24 },
                  ]}
                >
                  {label}
                </Text>
              </TabBarButton>
            </View>
          );
        })}
      </View>
      <View style={{ height: horizontal ? 21 : 34, backgroundColor: colors.background }} />
    </View>
  );
}

export const InteractiveNavigation: Story = {
  parameters: { layout: "fullscreen" },
  render: () => <NavigationPreview />,
};

export const LandscapeNavigation: Story = {
  parameters: { layout: "fullscreen" },
  render: () => <NavigationPreview horizontal />,
};
