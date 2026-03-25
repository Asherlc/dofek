import { StyleSheet, Text, View } from "react-native";
import { colors } from "../theme";

interface MacroSummaryProps {
  calories: number;
  caloriesGoal: number;
  proteinGrams: number;
  carbsGrams: number;
  fatGrams: number;
}

function MacroBar({ label, grams, color }: { label: string; grams: number; color: string }) {
  return (
    <View style={styles.macroItem}>
      <View style={[styles.macroDot, { backgroundColor: color }]} />
      <Text style={styles.macroLabel}>{label}</Text>
      <Text style={styles.macroValue}>{grams}g</Text>
    </View>
  );
}

export function MacroSummary({
  calories,
  caloriesGoal,
  proteinGrams,
  carbsGrams,
  fatGrams,
}: MacroSummaryProps) {
  const caloriesRemaining = caloriesGoal - calories;
  const progressFraction = Math.min(calories / caloriesGoal, 1);

  return (
    <View style={styles.container}>
      <View style={styles.calorieSection}>
        <Text style={styles.calorieCount}>{calories}</Text>
        <Text style={styles.calorieLabel}>of {caloriesGoal} cal</Text>
        <View style={styles.progressBarBackground}>
          <View
            style={[
              styles.progressBarFill,
              { width: `${progressFraction * 100}%` },
            ]}
          />
        </View>
        <Text style={styles.remainingText}>
          {caloriesRemaining > 0 ? `${caloriesRemaining} remaining` : "Goal reached"}
        </Text>
      </View>

      <View style={styles.macroSection}>
        <MacroBar label="Protein" grams={proteinGrams} color={colors.positive} />
        <MacroBar label="Carbs" grams={carbsGrams} color={colors.warning} />
        <MacroBar label="Fat" grams={fatGrams} color={colors.danger} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    padding: 16,
    marginBottom: 16,
  },
  calorieSection: {
    alignItems: "center",
    marginBottom: 16,
  },
  calorieCount: {
    fontSize: 36,
    fontWeight: "700",
    color: colors.text,
  },
  calorieLabel: {
    fontSize: 14,
    color: colors.textSecondary,
    marginBottom: 8,
  },
  progressBarBackground: {
    width: "100%",
    height: 8,
    backgroundColor: colors.surfaceSecondary,
    borderRadius: 4,
    overflow: "hidden",
  },
  progressBarFill: {
    height: "100%",
    backgroundColor: colors.accent,
    borderRadius: 4,
  },
  remainingText: {
    fontSize: 12,
    color: colors.textTertiary,
    marginTop: 4,
  },
  macroSection: {
    flexDirection: "row",
    justifyContent: "space-around",
  },
  macroItem: {
    alignItems: "center",
    gap: 2,
  },
  macroDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  macroLabel: {
    fontSize: 12,
    color: colors.textSecondary,
  },
  macroValue: {
    fontSize: 16,
    fontWeight: "600",
    color: colors.text,
  },
});
