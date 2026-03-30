import { Ionicons } from "@expo/vector-icons";
import { Tabs } from "expo-router";
import { StyleSheet } from "react-native";
import { colors } from "../../theme";

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: colors.accent,
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
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="heart" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="strain"
        options={{
          title: "Training",
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="barbell" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="food"
        options={{
          title: "Nutrition",
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="nutrition" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="metrics"
        options={{
          title: "Body",
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="body" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="health"
        options={{
          title: "More",
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="ellipsis-horizontal" size={size} color={color} />
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
});
