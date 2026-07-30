import { formatNutritionDataQualityMessages } from "@dofek/nutrition/nutrition-data-quality";
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

  const messages = formatNutritionDataQualityMessages(dataQuality);

  return (
    <View style={styles.card}>
      <Text style={styles.title}>Nutrition data quality</Text>
      <Text style={styles.body}>{messages.recorded}</Text>
      <Text style={styles.body}>{messages.coverage}</Text>
      <Text style={styles.body}>{messages.overlap}</Text>
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
