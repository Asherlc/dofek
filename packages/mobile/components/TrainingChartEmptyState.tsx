import type { TrainingChartAvailability } from "dofek-server/types";
import { StyleSheet, Text, View } from "react-native";
import { colors, spacing } from "../theme";

interface TrainingChartEmptyStateProps {
  availability: TrainingChartAvailability;
}

export function TrainingChartEmptyState({ availability }: TrainingChartEmptyStateProps) {
  return (
    <View style={styles.container} testID="training-chart-empty-state">
      <Text style={styles.message}>{availability.message}</Text>
      <Text style={styles.details}>
        {availability.observedCount} of {availability.minimumCount} required observations ·{" "}
        {availability.sourceLabel}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    gap: spacing.xs,
  },
  message: {
    color: colors.textSecondary,
    fontSize: 14,
    textAlign: "center",
  },
  details: {
    color: colors.textTertiary,
    fontSize: 12,
    textAlign: "center",
  },
});
