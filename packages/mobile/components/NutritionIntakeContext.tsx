import { formatCalories } from "@dofek/format/format";
import type { SelectedDateNutritionIntakeContext } from "@dofek/nutrition/selected-date-summary";
import { StyleSheet, Text, View } from "react-native";
import { colors } from "../theme";

interface NutritionIntakeContextProps {
  context: SelectedDateNutritionIntakeContext;
}

function accessibilityLabel(context: SelectedDateNutritionIntakeContext): string {
  return `Logged intake: ${formatCalories(context.observedCalories)}. ${context.target.label}: ${formatCalories(context.target.calories)}. ${context.comparison.message} Scale: 0 to ${formatCalories(context.scale.maximumCalories)}. ${context.limitation}`;
}

export function NutritionIntakeContext({ context }: NutritionIntakeContextProps) {
  return (
    <View style={styles.container} accessible accessibilityLabel={accessibilityLabel(context)}>
      <View style={styles.header}>
        <Text style={styles.title}>Logged intake</Text>
        <Text style={styles.observedCalories}>{formatCalories(context.observedCalories)}</Text>
      </View>
      <Text style={styles.target}>
        {context.target.label}: {formatCalories(context.target.calories)}
      </Text>
      <View style={styles.scale} accessible={false} testID="calorie-scale">
        <View
          style={[styles.observedScale, { width: `${context.scale.observedPercentage}%` }]}
          testID="calorie-scale-observed"
        />
        <View
          style={[styles.targetMarker, { left: `${context.scale.targetPercentage}%` }]}
          testID="calorie-scale-target"
        />
      </View>
      <View style={styles.scaleLabels} accessible={false}>
        <Text style={styles.scaleLabel}>{formatCalories(0)}</Text>
        <Text style={styles.scaleLabel}>{formatCalories(context.scale.maximumCalories)} scale</Text>
      </View>
      <Text style={styles.comparison}>{context.comparison.message}</Text>
      <Text style={styles.limitation}>{context.limitation}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    padding: 16,
    marginBottom: 16,
    gap: 8,
  },
  header: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 12,
  },
  title: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "600",
  },
  observedCalories: {
    color: colors.text,
    fontSize: 20,
    fontWeight: "700",
  },
  target: {
    color: colors.textSecondary,
    fontSize: 13,
  },
  scale: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: 4,
    height: 8,
    overflow: "visible",
    position: "relative",
    width: "100%",
  },
  observedScale: {
    backgroundColor: colors.accent,
    borderRadius: 4,
    height: "100%",
  },
  targetMarker: {
    backgroundColor: colors.text,
    height: 16,
    position: "absolute",
    top: -4,
    width: 2,
  },
  scaleLabels: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  scaleLabel: {
    color: colors.textTertiary,
    fontSize: 11,
  },
  comparison: {
    color: colors.textSecondary,
    fontSize: 13,
  },
  limitation: {
    color: colors.textTertiary,
    fontSize: 12,
  },
});
