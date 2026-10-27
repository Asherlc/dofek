import { formatGrams, formatNutritionNumber } from "@dofek/format/format";
import type { SelectedDateNutritionSummary } from "@dofek/nutrition/selected-date-summary";
import { chartColors } from "@dofek/scoring/colors";
import { StyleSheet, Text, View } from "react-native";
import { colors } from "../theme";

interface MacroSummaryProps {
  macros: SelectedDateNutritionSummary["macros"];
}

function MacroBar({
  label,
  grams,
  energySharePercentage,
  color,
}: {
  label: string;
  grams: number;
  energySharePercentage: number;
  color: string;
}) {
  const formattedGrams = formatNutritionNumber(grams);

  return (
    <View
      style={styles.macroItem}
      accessible
      accessibilityLabel={`${label}: ${formatNutritionNumber(energySharePercentage)}% of energy; ${formattedGrams} grams`}
    >
      <View style={[styles.macroDot, { backgroundColor: color }]} />
      <Text style={styles.macroLabel}>{label}</Text>
      <Text style={styles.macroValue}>{formatNutritionNumber(energySharePercentage)}%</Text>
      <Text style={styles.macroGrams}>{formatGrams(grams)}</Text>
    </View>
  );
}

export function MacroSummary({ macros }: MacroSummaryProps) {
  return (
    <View style={styles.container}>
      <View style={styles.macroSection}>
        <Text style={styles.macroSectionTitle}>Macros (% energy)</Text>
        <View style={styles.macroItems}>
          <MacroBar
            label="Protein"
            grams={macros.protein.grams}
            energySharePercentage={macros.protein.energySharePercentage}
            color={chartColors.blue}
          />
          <MacroBar
            label="Carbs"
            grams={macros.carbs.grams}
            energySharePercentage={macros.carbs.energySharePercentage}
            color={chartColors.purple}
          />
          <MacroBar
            label="Fat"
            grams={macros.fat.grams}
            energySharePercentage={macros.fat.energySharePercentage}
            color={chartColors.teal}
          />
        </View>
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
  macroSection: {
    gap: 2,
  },
  macroSectionTitle: {
    fontSize: 14,
    fontWeight: "600",
    color: colors.text,
  },
  macroItems: {
    flexDirection: "row",
    justifyContent: "space-around",
    marginTop: 8,
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
  macroGrams: {
    fontSize: 11,
    color: colors.textTertiary,
  },
});
