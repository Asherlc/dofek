import { formatCalories, formatGrams } from "@dofek/format/format";
import type { SelectedDateNutritionSummary } from "@dofek/nutrition/selected-date-summary";
import { StyleSheet, Text, View } from "react-native";
import { colors } from "../theme";

interface MacroSummaryProps {
  calories: number;
  calorieGoal: SelectedDateNutritionSummary["calorieGoal"];
  macros: SelectedDateNutritionSummary["macros"];
}

function MacroBar({ label, grams, color }: { label: string; grams: number; color: string }) {
  return (
    <View style={styles.macroItem}>
      <View style={[styles.macroDot, { backgroundColor: color }]} />
      <Text style={styles.macroLabel}>{label}</Text>
      <Text style={styles.macroValue}>{formatGrams(grams)}</Text>
    </View>
  );
}

export function MacroSummary({ calories, calorieGoal, macros }: MacroSummaryProps) {
  return (
    <View style={styles.container}>
      <View style={styles.calorieSection}>
        <Text style={styles.calorieCount}>{formatCalories(calories)}</Text>
        <Text style={styles.calorieLabel}>of {formatCalories(calorieGoal.target)}</Text>
        <View style={styles.progressBarBackground}>
          <View style={[styles.progressBarFill, { width: `${calorieGoal.progressPercentage}%` }]} />
        </View>
        <Text style={styles.remainingText}>
          {calorieGoal.remaining > 0
            ? `${formatCalories(calorieGoal.remaining)} remaining`
            : calorieGoal.over > 0
              ? `${formatCalories(calorieGoal.over)} over goal`
              : "Goal reached"}
        </Text>
      </View>

      <View style={styles.macroSection}>
        <MacroBar label="Protein" grams={macros.protein.grams} color={colors.positive} />
        <MacroBar label="Carbs" grams={macros.carbs.grams} color={colors.warning} />
        <MacroBar label="Fat" grams={macros.fat.grams} color={colors.danger} />
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
