import { Tabs } from "expo-router";
import { StyleSheet, Text } from "react-native";
import { colors } from "../../theme";

function TabIcon({ label, focused }: { label: string; focused: boolean }) {
  return <Text style={[styles.icon, { opacity: focused ? 1 : 0.4 }]}>{label}</Text>;
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
          title: "Dashboard",
          tabBarIcon: ({ focused }) => <TabIcon label={"\u2764\uFE0F"} focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="strain"
        options={{
          title: "Training",
          tabBarIcon: ({ focused }) => <TabIcon label={"\u26A1"} focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="food"
        options={{
          title: "Nutrition",
          tabBarIcon: ({ focused }) => <TabIcon label={"\uD83C\uDF4E"} focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="metrics"
        options={{
          title: "Body",
          tabBarIcon: ({ focused }) => <TabIcon label={"\uD83E\uDDA0"} focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="health"
        options={{
          title: "More",
          tabBarIcon: ({ focused }) => <TabIcon label={"\u2630"} focused={focused} />,
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
