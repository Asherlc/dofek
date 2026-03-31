import { Ionicons } from "@expo/vector-icons";
import { Tabs, useRouter } from "expo-router";
import { Pressable, StyleSheet } from "react-native";
import { colors } from "../../theme";
import { getTabIconName, selectedTabBackgroundColor } from "./tab-selection";

export default function TabsLayout() {
  const router = useRouter();

  return (
    <Tabs screenOptions={tabsScreenOptions}>
      <Tabs.Screen
        name="index"
        options={{
          title: "Today",
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons name={getTabIconName("index", focused)} size={size} color={color} />
          ),
          headerRight: () => (
            <Pressable onPress={() => router.push("/settings")} style={styles.headerButton}>
              <Ionicons name="settings-outline" size={22} color={colors.textSecondary} />
            </Pressable>
          ),
        }}
      />
      <Tabs.Screen
        name="recovery"
        options={{
          title: "Recovery",
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons name={getTabIconName("recovery", focused)} size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="strain"
        options={{
          title: "Training",
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons name={getTabIconName("strain", focused)} size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="food"
        options={{
          title: "Nutrition",
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons name={getTabIconName("food", focused)} size={size} color={color} />
          ),
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  tabBar: {
    backgroundColor: colors.background,
    borderTopColor: colors.surface,
    borderTopWidth: 0.5,
    paddingTop: 4,
  },
  tabBarItem: {
    borderRadius: 12,
    marginHorizontal: 6,
    marginTop: 4,
    marginBottom: 2,
  },
  tabBarLabel: {
    fontWeight: "600",
  },
  header: {
    backgroundColor: colors.background,
    shadowColor: "transparent",
    elevation: 0,
  },
  headerTitle: {
    fontWeight: "700",
    fontSize: 17,
  },
  headerButton: {
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
});

export const tabsScreenOptions = {
  tabBarActiveTintColor: colors.accent,
  tabBarInactiveTintColor: colors.textTertiary,
  tabBarStyle: styles.tabBar,
  tabBarItemStyle: styles.tabBarItem,
  tabBarLabelStyle: styles.tabBarLabel,
  tabBarActiveBackgroundColor: selectedTabBackgroundColor,
  headerStyle: styles.header,
  headerTintColor: colors.text,
  headerTitleStyle: styles.headerTitle,
} as const;
