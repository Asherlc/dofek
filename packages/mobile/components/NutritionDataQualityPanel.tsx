import { StyleSheet, Text, View } from "react-native";
import type { NutritionAnalyticsDataQuality } from "../../server/src/repositories/nutrition-analytics-repository";
import { colors } from "../theme";

interface NutritionDataQualityPanelProps {
  dataQuality?: NutritionAnalyticsDataQuality;
  loading?: boolean;
}

export function NutritionDataQualityPanel({
  dataQuality,
  loading = false,
}: NutritionDataQualityPanelProps) {
  if (loading) {
    return (
      <View
        style={styles.card}
        accessible
        accessibilityLabel="Loading nutrition data quality"
        accessibilityLiveRegion="polite"
      >
        <Text style={styles.body}>Loading nutrition data quality…</Text>
      </View>
    );
  }
  if (!dataQuality) return null;

  const coverage =
    dataQuality.selectedWindowDays == null
      ? `${dataQuality.usableDays} recorded days are usable.`
      : `${dataQuality.usableDays} of ${dataQuality.selectedWindowDays} selected days are usable (${dataQuality.completenessPercent}% completeness).`;
  const overlap =
    dataQuality.overlapDays === 0
      ? "No overlapping nutrition sources detected."
      : `${dataQuality.overlapDays} ${dataQuality.overlapDays === 1 ? "day contains" : "days contain"} overlapping sources; ${dataQuality.conflictDays} ${dataQuality.conflictDays === 1 ? "remains" : "remain"} unresolved.`;

  return (
    <View style={styles.card} accessible accessibilityLabel="Nutrition data quality">
      <Text style={styles.title}>Nutrition data quality</Text>
      <Text style={styles.body}>
        Nutrition data exists on {dataQuality.daysWithData} selected days.
      </Text>
      <Text style={styles.body}>{coverage}</Text>
      <Text style={styles.body}>{overlap}</Text>
      {dataQuality.contributingSourceLabels.length > 0 && (
        <Text style={styles.detail}>
          Contributing sources: {dataQuality.contributingSourceLabels.join(", ")}
        </Text>
      )}
      {dataQuality.excludedSourceLabels.length > 0 && (
        <Text style={styles.detail}>
          Excluded or conflicting sources: {dataQuality.excludedSourceLabels.join(", ")}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 12,
    borderWidth: 1,
    gap: 6,
    marginBottom: 16,
    padding: 16,
  },
  title: {
    color: colors.text,
    fontSize: 16,
    fontWeight: "700",
  },
  body: {
    color: colors.textSecondary,
    fontSize: 13,
  },
  detail: {
    color: colors.textSecondary,
    fontSize: 12,
  },
});
