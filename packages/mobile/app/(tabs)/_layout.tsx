import { Ionicons } from "@expo/vector-icons";
import { Tabs, useRouter } from "expo-router";
import { Pressable, StyleSheet, View } from "react-native";
import { AlertsBell } from "../../components/AlertsBell";
import { TabBarButton } from "../../components/TabBarButton";
import { getTabIconName, selectedTabBackgroundColor } from "../../lib/tab-selection";
import { useProcessingAlerts } from "../../lib/useProcessingAlerts";
import { colors } from "../../theme";

export default function TabsLayout() {
  const router = useRouter();
  const alerts = useProcessingAlerts();
  const activeAlertCount = alerts.data?.alerts.length ?? 0;
  const headerActions = () => (
    <View style={styles.headerActions}>
      <AlertsBell activeCount={activeAlertCount} onPress={() => router.push("/alerts")} />
      <Pressable
        onPress={() => router.push("/settings")}
        style={styles.headerButton}
        accessibilityRole="button"
        accessibilityLabel="Settings"
      >
        <Ionicons name="settings-outline" size={22} color={colors.textSecondary} />
      </Pressable>
    </View>
  );

  return (
    <Tabs screenOptions={{ ...tabsScreenOptions, headerRight: headerActions }}>
      <Tabs.Screen
        name="index"
        options={{
          title: "Today",
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons name={getTabIconName("index", focused)} size={size} style={{ color }} />
          ),
        }}
      />
      <Tabs.Screen
        name="recovery"
        options={{
          title: "Recovery",
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons name={getTabIconName("recovery", focused)} size={size} style={{ color }} />
          ),
        }}
      />
      <Tabs.Screen
        name="strain"
        options={{
          title: "Training",
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons name={getTabIconName("strain", focused)} size={size} style={{ color }} />
          ),
        }}
      />
      <Tabs.Screen
        name="activities"
        options={{
          title: "Activities",
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons name={getTabIconName("activities", focused)} size={size} style={{ color }} />
          ),
        }}
      />
      <Tabs.Screen
        name="food"
        options={{
          title: "Nutrition",
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons name={getTabIconName("food", focused)} size={size} style={{ color }} />
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
    elevation: 8,
    position: "relative",
    zIndex: 1,
  },
  tabBarItem: {
    marginHorizontal: 6,
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
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  headerActions: {
    alignItems: "center",
    flexDirection: "row",
    paddingRight: 4,
  },
});

export const tabsScreenOptions = {
  tabBarActiveTintColor: colors.accent,
  tabBarInactiveTintColor: colors.textSecondary,
  tabBarStyle: styles.tabBar,
  tabBarItemStyle: styles.tabBarItem,
  tabBarButton: TabBarButton,
  tabBarLabelStyle: styles.tabBarLabel,
  tabBarActiveBackgroundColor: selectedTabBackgroundColor,
  headerStyle: styles.header,
  headerTintColor: colors.text,
  headerTitleStyle: styles.headerTitle,
} as const;
