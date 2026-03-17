import { Tabs } from "expo-router";
import { StyleSheet, Text } from "react-native";
import { colors } from "../../theme";

function TabIcon({ label, focused }: { label: string; focused: boolean }) {
  return (
    <Text style={[styles.icon, { opacity: focused ? 1 : 0.4 }]}>{label}</Text>
  );
}

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: colors.text,
        tabBarInactiveTintColor: colors.textTertiary,
        tabBarStyle: styles.tabBar,
        headerStyle: styles.header,
        headerTintColor: colors.text,
        headerTitleStyle: styles.headerTitle,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Overview",
          tabBarIcon: ({ focused }) => (
            <TabIcon label={"\u2764\uFE0F"} focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="sleep"
        options={{
          title: "Sleep",
          tabBarIcon: ({ focused }) => (
            <TabIcon label={"\uD83C\uDF19"} focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="strain"
        options={{
          title: "Strain",
          tabBarIcon: ({ focused }) => (
            <TabIcon label={"\u26A1"} focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="food"
        options={{
          title: "Food",
          tabBarIcon: ({ focused }) => (
            <TabIcon label={"\uD83C\uDF4E"} focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="metrics"
        options={{
          title: "Trends",
          tabBarIcon: ({ focused }) => (
            <TabIcon label={"\uD83D\uDCC8"} focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="health"
        options={{
          title: "Sync",
          tabBarIcon: ({ focused }) => (
            <TabIcon label={"\u2699\uFE0F"} focused={focused} />
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
  header: {
    backgroundColor: colors.background,
    shadowColor: "transparent",
    elevation: 0,
  },
  headerTitle: {
    fontWeight: "700",
    fontSize: 17,
  },
  icon: {
    fontSize: 20,
  },
});
