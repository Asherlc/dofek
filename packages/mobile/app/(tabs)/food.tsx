import { formatDateLong, formatDateYmd } from "@dofek/format/format";
import { shouldShowBlockingLoading } from "@dofek/scoring/loading-policy";
import { useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { MacroSummary } from "../../components/MacroSummary";
import { MealSection } from "../../components/MealSection";
import { NutritionIntakeContext } from "../../components/NutritionIntakeContext";
import { openExternalUrl } from "../../lib/open-external-url";
import { safeParseData } from "../../lib/safe-parse";
import { logger } from "../../lib/telemetry";
import { trpc } from "../../lib/trpc";
import { useRefresh } from "../../lib/useRefresh";
import { colors } from "../../theme";
import { FoodByDateV2Schema, type FoodEntryRow } from "../../types/api";

const MEALS = [
  { key: "breakfast", label: "Breakfast" },
  { key: "lunch", label: "Lunch" },
  { key: "dinner", label: "Dinner" },
  { key: "snack", label: "Snack" },
  { key: "other", label: "Other" },
] as const;

const FATSECRET_URL = "https://www.fatsecret.com/";

function isToday(date: Date): boolean {
  const now = new Date();
  return (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  );
}

export default function FoodScreen() {
  const router = useRouter();
  const [selectedDate, setSelectedDate] = useState(() => new Date());
  const dateString = formatDateYmd(selectedDate);

  useEffect(() => {
    logger.info("screen-navigation", "Nutrition tab rendered", { route: "food" });
  }, []);

  const trpcUtils = trpc.useUtils();
  const foodQuery = trpc.food.byDateV2.useQuery(
    { date: dateString },
    { placeholderData: (previousData) => previousData },
  );
  const foodResponse =
    foodQuery.data === undefined && (foodQuery.isLoading || foodQuery.isFetching)
      ? undefined
      : foodQuery.data;
  const selectedDateFood =
    foodResponse === undefined
      ? { data: undefined, error: null }
      : safeParseData(FoodByDateV2Schema, foodResponse, "food:byDateV2");
  const entries = selectedDateFood.data?.entries ?? [];
  const summary = selectedDateFood.data?.summary;
  const resolution = selectedDateFood.data?.resolution;
  const isFoodBlockingLoading = shouldShowBlockingLoading({
    data: entries,
    isFetching: foodQuery.isFetching,
    isLoading: foodQuery.isLoading,
  });
  const foodError = foodQuery.error ?? selectedDateFood.error;
  const foodErrorMessage =
    foodError instanceof Error ? foodError.message : "Failed to load food entries.";
  const mealGroups = useMemo(() => {
    const groups = new Map<string, FoodEntryRow[]>();
    for (const entry of entries) {
      const meal = entry.meal || "other";
      groups.set(meal, [...(groups.get(meal) ?? []), entry]);
    }
    return groups;
  }, [entries]);

  const { refreshing, onRefresh } = useRefresh({
    invalidate: () => trpcUtils.food.byDateV2.invalidate({ date: dateString }),
  });

  function shiftDate(days: number) {
    setSelectedDate((current) => {
      const next = new Date(current);
      next.setDate(next.getDate() + days);
      return next;
    });
  }

  return (
    <View style={styles.container}>
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.textSecondary}
          />
        }
      >
        <View style={styles.dateNav}>
          <TouchableOpacity
            onPress={() => shiftDate(-1)}
            style={styles.dateArrow}
            accessibilityRole="button"
            accessibilityLabel="Previous day"
          >
            <Text style={styles.dateArrowText}>‹</Text>
          </TouchableOpacity>
          <Text style={styles.dateHeader}>{formatDateLong(selectedDate)}</Text>
          <TouchableOpacity
            onPress={() => shiftDate(1)}
            style={styles.dateArrow}
            accessibilityRole="button"
            accessibilityLabel="Next day"
          >
            <Text style={styles.dateArrowText}>›</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.sectionLinksRow}>
          <TouchableOpacity
            onPress={() => router.push("/nutrition-analytics")}
            style={styles.sectionLinkButton}
            accessibilityRole="button"
            accessibilityLabel="Nutrition Analytics"
          >
            <Text style={styles.sectionLinkText}>Analytics</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => router.push("/supplements")}
            style={styles.sectionLinkButton}
            accessibilityRole="button"
            accessibilityLabel="Supplements"
          >
            <Text style={styles.sectionLinkText}>Supplements</Text>
          </TouchableOpacity>
        </View>

        {!isToday(selectedDate) && (
          <TouchableOpacity
            onPress={() => setSelectedDate(new Date())}
            style={styles.todayButton}
            accessibilityRole="button"
            accessibilityLabel="Go to Today"
          >
            <Text style={styles.todayButtonText}>Go to Today</Text>
          </TouchableOpacity>
        )}

        {summary && (
          <>
            {selectedDateFood.data?.intakeContext && (
              <NutritionIntakeContext context={selectedDateFood.data.intakeContext} />
            )}
            <MacroSummary macros={summary.macros} />
          </>
        )}

        {resolution &&
          resolution.sourceProviders.length > 0 &&
          resolution.status === "available" && (
            <View
              style={styles.sourceResolution}
              accessible
              accessibilityLabel={[
                "Source coverage",
                resolution.contributionLabel,
                resolution.message,
                resolution.excludedSourceLabels.length > 0
                  ? `Excluded overlapping sources: ${resolution.excludedSourceLabels.join(", ")}`
                  : null,
              ]
                .filter(Boolean)
                .join(". ")}
            >
              <Text style={styles.sourceResolutionHeading}>Source coverage</Text>
              {resolution.contributionLabel ? (
                <Text style={styles.sourceResolutionTitle}>{resolution.contributionLabel}</Text>
              ) : null}
              <Text style={styles.sourceResolutionMessage}>{resolution.message}</Text>
              {resolution.excludedSourceLabels.length > 0 ? (
                <Text style={styles.sourceResolutionSources}>
                  Excluded overlapping sources: {resolution.excludedSourceLabels.join(", ")}
                </Text>
              ) : null}
            </View>
          )}

        {resolution?.status === "source_conflict" && (
          <View
            style={styles.sourceConflict}
            accessible
            accessibilityRole="alert"
            accessibilityLabel={`${resolution.message} Sources: ${resolution.sourceLabels.join(", ")}`}
          >
            <Text style={styles.sourceConflictTitle}>Nutrition source conflict</Text>
            <Text style={styles.sourceConflictMessage}>{resolution.message}</Text>
            <Text style={styles.sourceConflictSources}>
              Sources: {resolution.sourceLabels.join(", ")}
            </Text>
          </View>
        )}

        {isFoodBlockingLoading ? (
          <Text style={styles.loadingText}>Loading...</Text>
        ) : foodQuery.isError || selectedDateFood.error || !resolution ? (
          <Text style={styles.errorText}>{foodErrorMessage}</Text>
        ) : (
          MEALS.map(({ key, label }) => (
            <MealSection
              key={key}
              mealName={label}
              entries={mealGroups.get(key) ?? []}
              totalCalories={summary?.mealCalories[key] ?? null}
            />
          ))
        )}

        <TouchableOpacity
          accessibilityRole="link"
          accessibilityLabel="Powered by fatsecret nutrition API (www.fatsecret.com)"
          onPress={() => void openExternalUrl(FATSECRET_URL, "food")}
          style={styles.fatsecretAttributionLink}
        >
          <Text style={styles.fatsecretAttribution}>
            Powered by fatsecret nutrition API (www.fatsecret.com)
          </Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  scrollView: { flex: 1 },
  content: { padding: 16, paddingBottom: 100, gap: 12 },
  dateNav: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 16 },
  dateArrow: { padding: 8 },
  dateArrowText: { fontSize: 28, color: colors.accent, fontWeight: "300" },
  dateHeader: { fontSize: 20, fontWeight: "700", color: colors.text },
  todayButton: {
    alignSelf: "center",
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.accent,
  },
  todayButtonText: { fontSize: 13, color: colors.accent, fontWeight: "500" },
  sectionLinksRow: { flexDirection: "row", justifyContent: "center", gap: 12 },
  sectionLinkButton: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.accent,
  },
  sectionLinkText: { fontSize: 14, color: colors.accent, fontWeight: "600" },
  sourceResolution: {
    backgroundColor: colors.surface,
    borderColor: colors.surfaceSecondary,
    borderRadius: 12,
    borderWidth: 1,
    padding: 12,
    gap: 4,
  },
  sourceResolutionHeading: {
    color: colors.textTertiary,
    fontSize: 11,
    fontWeight: "600",
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  sourceResolutionTitle: { color: colors.text, fontSize: 14, fontWeight: "600" },
  sourceResolutionMessage: { color: colors.textSecondary, fontSize: 13 },
  sourceResolutionSources: { color: colors.textTertiary, fontSize: 12 },
  sourceConflict: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.warning,
    backgroundColor: colors.surface,
    padding: 14,
    gap: 4,
  },
  sourceConflictTitle: { color: colors.text, fontSize: 15, fontWeight: "700" },
  sourceConflictMessage: { color: colors.textSecondary, fontSize: 13, lineHeight: 18 },
  sourceConflictSources: { color: colors.textTertiary, fontSize: 12 },
  loadingText: { color: colors.textSecondary, textAlign: "center", padding: 24 },
  errorText: { color: colors.danger, textAlign: "center", padding: 24 },
  fatsecretAttributionLink: { alignItems: "center", paddingVertical: 8 },
  fatsecretAttribution: { color: colors.textTertiary, fontSize: 12 },
});
