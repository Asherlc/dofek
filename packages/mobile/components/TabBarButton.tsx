import { PlatformPressable } from "expo-router/react-navigation";
import type { BottomTabBarButtonProps } from "expo-router/tabs";
import { StyleSheet } from "react-native";

export function TabBarButton({ style, ...props }: BottomTabBarButtonProps) {
  return <PlatformPressable {...props} style={[style, styles.button]} />;
}

const styles = StyleSheet.create({
  button: {
    borderRadius: 12,
    justifyContent: "center",
    paddingTop: 3,
    paddingBottom: 3,
  },
});
