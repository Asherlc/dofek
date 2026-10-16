import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { colors, spacing } from "../theme";

export function MapProcessingState() {
  return (
    <View
      accessible
      accessibilityLabel="Processing map"
      accessibilityRole="progressbar"
      accessibilityState={{ busy: true }}
      accessibilityLiveRegion="polite"
      style={styles.container}
    >
      <ActivityIndicator accessible={false} color={colors.accent} size="small" />
      <Text style={styles.label}>Processing map…</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.xs,
    padding: spacing.xs,
    backgroundColor: colors.surfaceSecondary,
  },
  label: {
    color: colors.textSecondary,
    fontSize: 12,
    textAlign: "center",
  },
});
