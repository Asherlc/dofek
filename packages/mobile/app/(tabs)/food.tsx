import { formatCalories, formatDateLong, formatDateYmd } from "@dofek/format/format";
import { autoMealType } from "@dofek/nutrition/meal";
import { shouldShowBlockingLoading } from "@dofek/scoring/loading-policy";
import { useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import {
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { MacroSummary } from "../../components/MacroSummary";
import { MealSection } from "../../components/MealSection";
import { NutritionIntakeContext } from "../../components/NutritionIntakeContext";
import { openExternalUrl } from "../../lib/open-external-url";
import { safeParseData } from "../../lib/safe-parse";
import { captureException, logger } from "../../lib/telemetry";
import { trpc } from "../../lib/trpc";
import { useRefresh } from "../../lib/useRefresh";
import { colors } from "../../theme";
import { FoodByDateV2Schema, type FoodEntryRow } from "../../types/api";
import { type LoggerTab, TABS } from "../food/add-types";

const MEALS = [
  { key: "breakfast", label: "Breakfast" },
  { key: "lunch", label: "Lunch" },
  { key: "dinner", label: "Dinner" },
  { key: "snack", label: "Snack" },
  { key: "other", label: "Other" },
] as const;

const FATSECRET_URL = "https://www.fatsecret.com/";

function formatDateForQuery(date: Date): string {
  return formatDateYmd(date);
}

function formatDateForDisplay(date: Date): string {
  return formatDateLong(date);
}

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
  const [aiMealInput, setAiMealInput] = useState("");
  const [aiMealInputError, setAiMealInputError] = useState<string | null>(null);
  const dateString = formatDateForQuery(selectedDate);

  useEffect(() => {
    logger.info("screen-navigation", "Nutrition tab rendered", { route: "food" });
  }, []);

  const trpcUtils = trpc.useUtils();
  const foodQuery = trpc.food.byDateV2.useQuery(
    { date: dateString },
    { placeholderData: (previousData) => previousData },
  );
  const analyzeItemsMutation = trpc.food.analyzeItemsWithAi.useMutation();
  const createAiEntryMutation = trpc.food.create.useMutation();
  type AiMealItems = Awaited<ReturnType<typeof analyzeItemsMutation.mutateAsync>>["items"];
  const [pendingAiMealItems, setPendingAiMealItems] = useState<AiMealItems>([]);
  const deleteMutation = trpc.food.delete.useMutation({
    onSuccess: () => foodQuery.refetch(),
  });

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
      const existing = groups.get(meal) ?? [];
      existing.push(entry);
      groups.set(meal, existing);
    }
    return groups;
  }, [entries]);

  function goToPreviousDay() {
    setSelectedDate((prev) => {
      const next = new Date(prev);
      next.setDate(next.getDate() - 1);
      return next;
    });
  }

  function goToNextDay() {
    setSelectedDate((prev) => {
      const next = new Date(prev);
      next.setDate(next.getDate() + 1);
      return next;
    });
  }

  function handleAddFood(mealKey: string) {
    router.push(`/food/add?meal=${mealKey}&date=${dateString}`);
  }

  function handleOpenFoodInput(mode: LoggerTab) {
    router.push(`/food/add?meal=${autoMealType()}&date=${dateString}&mode=${mode}`);
  }

  function handleDeleteFood(id: string) {
    deleteMutation.mutate({ id });
  }

  function handleOpenFatsecretWebsite() {
    void openExternalUrl(FATSECRET_URL, "food");
  }

  async function handleLogAiMeal() {
    const trimmedInput = aiMealInput.trim();
    if (!trimmedInput) return;

    setAiMealInputError(null);
    try {
      const parsedResult = await analyzeItemsMutation.mutateAsync({
        description: trimmedInput,
      });
      setPendingAiMealItems(parsedResult.items);
    } catch (error) {
      captureException(error, { source: "food-ai-meal-input" });
      const errorMessage =
        error instanceof Error ? error.message : "Could not log this meal with AI input";
      setAiMealInputError(errorMessage);
    }
  }

  async function handleConfirmAiMeal() {
    if (pendingAiMealItems.length === 0) return;

    setAiMealInputError(null);
    try {
      for (const parsedItem of pendingAiMealItems) {
        await createAiEntryMutation.mutateAsync({
          date: dateString,
          nutrients: {},
          ...parsedItem,
        });
      }
      await foodQuery.refetch();
      setAiMealInput("");
      setPendingAiMealItems([]);
    } catch (error) {
      captureException(error, { source: "food-ai-meal-confirm" });
      const errorMessage =
        error instanceof Error ? error.message : "Could not log this meal with AI input";
      setAiMealInputError(errorMessage);
    }
  }

  function handleAiMealInputChange(value: string) {
    setAiMealInput(value);
    setPendingAiMealItems([]);
  }

  const { refreshing, onRefresh } = useRefresh({
    invalidate: () => trpcUtils.food.byDateV2.invalidate({ date: dateString }),
  });
  const aiLoggingInProgress = analyzeItemsMutation.isPending || createAiEntryMutation.isPending;

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
        {/* Date navigation */}
        <View style={styles.dateNav}>
          <TouchableOpacity
            onPress={goToPreviousDay}
            style={styles.dateArrow}
            accessibilityRole="button"
            accessibilityLabel="Previous day"
          >
            <Text style={styles.dateArrowText}>{"\u2039"}</Text>
          </TouchableOpacity>
          <Text style={styles.dateHeader}>{formatDateForDisplay(selectedDate)}</Text>
          <TouchableOpacity
            onPress={goToNextDay}
            style={styles.dateArrow}
            accessibilityRole="button"
            accessibilityLabel="Next day"
          >
            <Text style={styles.dateArrowText}>{"\u203A"}</Text>
          </TouchableOpacity>
        </View>

        {/* Section links */}
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

        <View style={styles.foodInputCard}>
          <Text style={styles.foodInputTitle}>Food input</Text>
          <View style={styles.foodInputGrid}>
            {TABS.map(({ key, label }) => (
              <TouchableOpacity
                key={key}
                onPress={() => handleOpenFoodInput(key)}
                style={styles.foodInputButton}
                activeOpacity={0.8}
                accessibilityRole="button"
                accessibilityLabel={label}
              >
                <Text style={styles.foodInputButtonText}>{label}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        <View style={styles.aiInputCard}>
          <Text style={styles.aiInputTitle}>AI meal input</Text>
          <Text style={styles.aiInputSubtitle}>
            Describe what you ate and automatically split it into items to log.
          </Text>
          <TextInput
            style={styles.aiInputField}
            value={aiMealInput}
            onChangeText={handleAiMealInputChange}
            placeholder="two eggs, toast with butter, and coffee with milk"
            placeholderTextColor={colors.textTertiary}
            multiline
            numberOfLines={3}
            textAlignVertical="top"
          />
          {aiMealInputError && <Text style={styles.aiInputError}>{aiMealInputError}</Text>}
          <TouchableOpacity
            style={[
              styles.aiInputButton,
              (aiLoggingInProgress || !aiMealInput.trim()) && styles.aiInputButtonDisabled,
            ]}
            onPress={handleLogAiMeal}
            disabled={aiLoggingInProgress || !aiMealInput.trim()}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel="Log with AI"
            accessibilityState={{
              busy: aiLoggingInProgress,
              disabled: aiLoggingInProgress || !aiMealInput.trim(),
            }}
          >
            <Text style={styles.aiInputButtonText}>
              {aiLoggingInProgress ? "Logging..." : "Log with AI"}
            </Text>
          </TouchableOpacity>
          {pendingAiMealItems.length > 0 && (
            <View style={styles.aiReviewCard}>
              <Text style={styles.aiReviewTitle}>Review AI meal</Text>
              {pendingAiMealItems.map((item) => (
                <View
                  key={`${item.meal}-${item.foodName}-${item.foodDescription}`}
                  style={styles.aiReviewItem}
                >
                  <View style={styles.aiReviewItemText}>
                    <Text style={styles.aiReviewFoodName}>{item.foodName}</Text>
                    <Text style={styles.aiReviewDescription}>{item.foodDescription}</Text>
                  </View>
                  <Text style={styles.aiReviewCalories}>{formatCalories(item.calories)}</Text>
                </View>
              ))}
              <View style={styles.aiReviewActions}>
                <TouchableOpacity
                  style={styles.aiReviewCancelButton}
                  onPress={() => setPendingAiMealItems([])}
                  activeOpacity={0.8}
                  accessibilityRole="button"
                  accessibilityLabel="Cancel AI meal"
                >
                  <Text style={styles.aiReviewCancelText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[
                    styles.aiReviewConfirmButton,
                    createAiEntryMutation.isPending && styles.aiInputButtonDisabled,
                  ]}
                  onPress={handleConfirmAiMeal}
                  disabled={createAiEntryMutation.isPending}
                  activeOpacity={0.8}
                  accessibilityRole="button"
                  accessibilityLabel="Confirm and log AI meal"
                  accessibilityState={{
                    busy: createAiEntryMutation.isPending,
                    disabled: createAiEntryMutation.isPending,
                  }}
                >
                  <Text style={styles.aiReviewConfirmText}>
                    {createAiEntryMutation.isPending ? "Logging..." : "Confirm and log"}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
          )}
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
        resolution.status === "available" ? (
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
        ) : null}

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
              mealKey={key}
              entries={mealGroups.get(key) ?? []}
              totalCalories={summary?.mealCalories[key] ?? null}
              onAddFood={handleAddFood}
              onDeleteFood={handleDeleteFood}
              deleting={deleteMutation.isPending}
            />
          ))
        )}
        <Pressable
          accessibilityRole="link"
          accessibilityLabel="Powered by fatsecret nutrition API (www.fatsecret.com)"
          onPress={handleOpenFatsecretWebsite}
          style={styles.fatsecretAttributionLink}
        >
          <Text style={styles.fatsecretAttribution}>
            Powered by fatsecret nutrition API (www.fatsecret.com)
          </Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  sourceResolution: {
    backgroundColor: colors.surface,
    borderColor: colors.surfaceSecondary,
    borderRadius: 12,
    borderWidth: 1,
    padding: 12,
    gap: 4,
  },
  sourceResolutionTitle: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "600",
  },
  sourceResolutionHeading: {
    color: colors.textTertiary,
    fontSize: 11,
    fontWeight: "600",
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  sourceResolutionMessage: {
    color: colors.textSecondary,
    fontSize: 13,
  },
  sourceResolutionSources: {
    color: colors.textTertiary,
    fontSize: 12,
  },
  scrollView: {
    flex: 1,
  },
  content: {
    padding: 16,
    paddingBottom: 100,
  },
  sourceConflict: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.warning,
    backgroundColor: colors.surface,
    padding: 14,
    marginBottom: 12,
    gap: 4,
  },
  sourceConflictTitle: {
    color: colors.text,
    fontSize: 15,
    fontWeight: "700",
  },
  sourceConflictMessage: {
    color: colors.textSecondary,
    fontSize: 13,
    lineHeight: 18,
  },
  sourceConflictSources: {
    color: colors.textTertiary,
    fontSize: 12,
  },
  dateNav: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 16,
    gap: 16,
  },
  dateArrow: {
    padding: 8,
  },
  dateArrowText: {
    fontSize: 28,
    color: colors.accent,
    fontWeight: "300",
  },
  dateHeader: {
    fontSize: 20,
    fontWeight: "700",
    color: colors.text,
  },
  todayButton: {
    alignSelf: "center",
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.accent,
    marginBottom: 12,
  },
  todayButtonText: {
    fontSize: 13,
    color: colors.accent,
    fontWeight: "500",
  },
  sectionLinksRow: {
    flexDirection: "row",
    justifyContent: "center",
    gap: 12,
    marginBottom: 12,
  },
  sectionLinkButton: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.accent,
  },
  sectionLinkText: {
    fontSize: 14,
    color: colors.accent,
    fontWeight: "600",
  },
  foodInputCard: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.surfaceSecondary,
    backgroundColor: colors.surface,
    padding: 14,
    marginBottom: 12,
    gap: 10,
  },
  foodInputTitle: {
    color: colors.text,
    fontSize: 15,
    fontWeight: "700",
  },
  foodInputGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  foodInputButton: {
    flexGrow: 1,
    flexBasis: "45%",
    alignItems: "center",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.accent,
    paddingVertical: 11,
    paddingHorizontal: 10,
    backgroundColor: colors.background,
  },
  foodInputButtonText: {
    color: colors.accent,
    fontSize: 14,
    fontWeight: "700",
  },
  aiInputCard: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.surfaceSecondary,
    backgroundColor: colors.surface,
    padding: 14,
    marginBottom: 12,
    gap: 8,
  },
  aiInputTitle: {
    color: colors.text,
    fontSize: 15,
    fontWeight: "700",
  },
  aiInputSubtitle: {
    color: colors.textSecondary,
    fontSize: 13,
    lineHeight: 18,
  },
  aiInputField: {
    minHeight: 80,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.surfaceSecondary,
    backgroundColor: colors.background,
    color: colors.text,
    fontSize: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  aiInputError: {
    color: "#fca5a5",
    fontSize: 12,
  },
  aiInputButton: {
    borderRadius: 10,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 10,
    paddingHorizontal: 14,
  },
  aiInputButtonDisabled: {
    opacity: 0.5,
  },
  aiInputButtonText: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "700",
  },
  aiReviewCard: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.surfaceSecondary,
    backgroundColor: colors.background,
    padding: 10,
    gap: 8,
  },
  aiReviewTitle: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "700",
  },
  aiReviewItem: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.surfaceSecondary,
    padding: 10,
  },
  aiReviewItemText: {
    flex: 1,
    gap: 2,
  },
  aiReviewFoodName: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "700",
  },
  aiReviewDescription: {
    color: colors.textSecondary,
    fontSize: 12,
  },
  aiReviewCalories: {
    color: colors.text,
    fontSize: 12,
    fontWeight: "700",
  },
  aiReviewActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 8,
  },
  aiReviewCancelButton: {
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  aiReviewCancelText: {
    color: colors.textSecondary,
    fontSize: 14,
    fontWeight: "600",
  },
  aiReviewConfirmButton: {
    borderRadius: 10,
    backgroundColor: colors.accent,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  aiReviewConfirmText: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "700",
  },
  loadingText: {
    textAlign: "center",
    color: colors.textTertiary,
    paddingVertical: 24,
  },
  errorText: {
    textAlign: "center",
    color: "#f87171",
    fontSize: 13,
    paddingVertical: 24,
  },
  fatsecretAttribution: {
    color: colors.textTertiary,
    fontSize: 12,
    fontWeight: "600",
    textAlign: "center",
  },
  fatsecretAttributionLink: {
    alignSelf: "center",
    marginTop: 10,
  },
});
