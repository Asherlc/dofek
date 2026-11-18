import { Ionicons } from "@expo/vector-icons";
import { Tabs, useRouter } from "expo-router";
import { StyleSheet } from "react-native";
import { AlertsBell } from "../../components/AlertsBell";
import { TabBarButton } from "../../components/TabBarButton";
import { getTabIconName, primaryTabs, selectedTabBackgroundColor } from "../../lib/tab-selection";
import { useProcessingAlerts } from "../../lib/useProcessingAlerts";
import { colors } from "../../theme";

export default function TabsLayout() {
  const router = useRouter();
  const alerts = useProcessingAlerts();
  const activeAlertCount = alerts.data?.alerts.length ?? 0;
  return (
    <Tabs
      screenOptions={{
        ...tabsScreenOptions,
        headerRight: () => (
          <AlertsBell activeCount={activeAlertCount} onPress={() => router.push("/alerts")} />
        ),
      }}
    >
      {primaryTabs.map(({ name, title }) => (
        <Tabs.Screen
          key={name}
          name={name}
          options={{
            title,
            ...(name === "index" ? { headerTitle: "Dofek" } : {}),
            tabBarIcon: ({ color, size, focused }) => (
              <Ionicons name={getTabIconName(name, focused)} size={size} style={{ color }} />
            ),
          }}
        />
      ))}
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
