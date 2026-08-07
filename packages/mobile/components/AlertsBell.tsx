import { Ionicons } from "@expo/vector-icons";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors } from "../theme";

export function AlertsBell({ activeCount, onPress }: { activeCount: number; onPress: () => void }) {
  const accessibilityLabel = activeCount === 0 ? "Alerts" : `Alerts, ${activeCount} active`;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      style={styles.button}
    >
      <Ionicons name="notifications-outline" size={22} color={colors.textSecondary} />
      {activeCount > 0 ? (
        <View style={styles.badge} pointerEvents="none">
          <Text style={styles.badgeText}>{activeCount > 99 ? "99+" : activeCount}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    alignItems: "center",
    height: 40,
    justifyContent: "center",
    position: "relative",
    width: 40,
  },
  badge: {
    alignItems: "center",
    backgroundColor: colors.danger,
    borderRadius: 8,
    justifyContent: "center",
    minHeight: 16,
    minWidth: 16,
    paddingHorizontal: 4,
    position: "absolute",
    right: 1,
    top: 1,
  },
  badgeText: {
    color: "#ffffff",
    fontSize: 10,
    fontWeight: "800",
    lineHeight: 14,
  },
});
