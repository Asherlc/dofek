import { MEAL_OPTIONS } from "@dofek/nutrition/meal";
import {
  Linking,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { z } from "zod";
import { SupplementDoseEventsPanel } from "../components/SupplementDoseEventsPanel";
import { captureException } from "../lib/telemetry";
import { trpc } from "../lib/trpc";
import { useRefresh } from "../lib/useRefresh";
import { colors } from "../theme";

const supplementSchema = z.object({
  name: z.string(),
  amount: z.number().optional(),
  unit: z.string().optional(),
  form: z.string().optional(),
  meal: z.enum(["breakfast", "lunch", "dinner", "snack", "other"]).optional(),
  description: z.string().optional(),
});
type Supplement = z.infer<typeof supplementSchema>;

function formatDose(supp: Supplement): string {
  const parts: string[] = [];
  if (supp.amount != null && supp.unit) {
    parts.push(`${supp.amount}${supp.unit}`);
  }
  if (supp.form) {
    parts.push(supp.form);
  }
  return parts.join(" \u00B7 ");
}

export default function SupplementsScreen() {
  const stack = trpc.supplements.list.useQuery();
  const safetyReview = trpc.nutritionAnalytics.micronutrientAdequacyV2.useQuery({ days: 30 });

  const supplements = z.array(supplementSchema).parse(stack.data ?? []);
  const hasCanonicalStack = stack.data !== undefined;

  const { refreshing, onRefresh } = useRefresh();

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          tintColor={colors.textSecondary}
        />
      }
    >
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>Supplements</Text>
      </View>

      {stack.isLoading && !hasCanonicalStack && <Text style={styles.loadingText}>Loading...</Text>}

      {stack.error && (
        <Text style={styles.errorText}>
          {hasCanonicalStack ? `Refresh failed: ${stack.error.message}` : stack.error.message}
        </Text>
      )}

      {supplements.length === 0 && !stack.isLoading && !stack.error ? (
        <Text style={styles.emptyText}>No synced supplements available.</Text>
      ) : null}

      {supplements.map((supp) => {
        const dose = formatDose(supp);
        const mealLabel = MEAL_OPTIONS.find((meal) => meal.value === supp.meal)?.label;
        return (
          <View key={supp.name} style={styles.card}>
            <View style={styles.cardContent}>
              <Text style={styles.cardLabel}>{supp.name}</Text>
              {dose ? <Text style={styles.cardSub}>{dose}</Text> : null}
              {mealLabel ? <Text style={styles.cardMeal}>{mealLabel}</Text> : null}
            </View>
          </View>
        );
      })}

      <View style={styles.safetySection}>
        <Text style={styles.sectionTitle}>Safety Context</Text>
        <Text style={styles.sectionSubtitle}>
          U.S. Food and Drug Administration (FDA) label references, bounded National Institutes of
          Health (NIH) adult upper limits, and medication-review guidance
        </Text>
        {safetyReview.isLoading && <Text style={styles.loadingText}>Loading...</Text>}
        {safetyReview.error && <Text style={styles.errorText}>{safetyReview.error.message}</Text>}
        {safetyReview.data && (
          <>
            <View
              style={[
                styles.safetyCard,
                safetyReview.data.professionalReview.status === "professional_review_recommended" &&
                  styles.safetyWarning,
              ]}
            >
              <Text style={styles.safetyTitle}>Medication and supplement review</Text>
              <Text style={styles.safetyText}>{safetyReview.data.professionalReview.message}</Text>
              <Text style={styles.safetyLimitation}>
                {safetyReview.data.professionalReview.limitation}
              </Text>
              <TouchableOpacity
                onPress={() => {
                  void Linking.openURL(safetyReview.data.professionalReview.source.url).catch(
                    (error: unknown) =>
                      captureException(error, { operation: "supplements.openFdaSource" }),
                  );
                }}
                accessibilityRole="link"
                accessibilityLabel="Open FDA source"
              >
                <Text style={styles.sourceLink}>FDA source</Text>
              </TouchableOpacity>
            </View>
            {safetyReview.data.nutrients
              .filter((nutrient) => nutrient.intake.supplementDailyAverage > 0)
              .map((nutrient) => {
                const sourceUrl =
                  nutrient.upperLimit.status === "not_in_ruleset"
                    ? null
                    : nutrient.upperLimit.source.url;
                return (
                  <View
                    key={nutrient.nutrientId}
                    style={[
                      styles.safetyCard,
                      nutrient.safetyStatus === "at_or_above_upper_limit" && styles.safetyDanger,
                      nutrient.safetyStatus === "upper_limit_not_evaluable" && styles.safetyWarning,
                    ]}
                  >
                    <Text style={styles.safetyTitle}>{nutrient.nutrient}</Text>
                    <Text style={styles.safetyMeta}>
                      {nutrient.intake.supplementDailyAverage} {nutrient.unit} average from
                      supplements over {nutrient.intake.daysTracked} recorded days
                    </Text>
                    <Text style={styles.safetyText}>{nutrient.upperLimit.message}</Text>
                    {sourceUrl != null && (
                      <TouchableOpacity
                        onPress={() => {
                          void Linking.openURL(sourceUrl).catch((error: unknown) =>
                            captureException(error, {
                              operation: "supplements.openNihSource",
                            }),
                          );
                        }}
                        accessibilityRole="link"
                        accessibilityLabel={`Open NIH ODS source for ${nutrient.nutrient}`}
                      >
                        <Text style={styles.sourceLink}>NIH ODS source</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                );
              })}
          </>
        )}
      </View>

      <View style={styles.doseSection}>
        <Text style={styles.sectionTitle}>Recent Doses</Text>
        <Text style={styles.sectionSubtitle}>
          Provider-recorded planned, taken, skipped, and unknown dose-event history.
        </Text>
        <SupplementDoseEventsPanel />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { padding: 16, paddingTop: 24, paddingBottom: 40 },
  sectionHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 12,
  },
  sectionTitle: { fontSize: 20, fontWeight: "700", color: colors.text },
  sectionSubtitle: {
    color: colors.textSecondary,
    fontSize: 13,
    marginBottom: 12,
    marginTop: 4,
  },
  safetySection: { marginTop: 28 },
  safetyCard: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.textTertiary,
    padding: 14,
    marginBottom: 8,
  },
  safetyWarning: { borderColor: colors.warning },
  safetyDanger: { borderColor: colors.danger },
  safetyTitle: { fontSize: 15, fontWeight: "700", color: colors.text },
  safetyText: { fontSize: 13, color: colors.text, marginTop: 6 },
  safetyMeta: { fontSize: 12, color: colors.textSecondary, marginTop: 4 },
  safetyLimitation: { fontSize: 12, color: colors.textSecondary, marginTop: 8 },
  sourceLink: { fontSize: 12, color: colors.accent, textDecorationLine: "underline", marginTop: 8 },
  doseSection: { marginTop: 28 },
  card: { backgroundColor: colors.surface, borderRadius: 12, padding: 14, marginBottom: 8 },
  cardContent: { flex: 1 },
  cardLabel: { fontSize: 16, fontWeight: "600", color: colors.text },
  cardSub: { fontSize: 13, color: colors.textSecondary, marginTop: 2 },
  cardMeal: {
    fontSize: 12,
    color: colors.textTertiary,
    marginTop: 2,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  loadingText: {
    fontSize: 14,
    color: colors.textSecondary,
    textAlign: "center",
    paddingVertical: 16,
  },
  emptyText: { fontSize: 14, color: colors.textTertiary, textAlign: "center", paddingVertical: 16 },
  errorText: { fontSize: 13, color: colors.danger, marginTop: 8 },
});
