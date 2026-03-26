import { useRouter } from "expo-router";
import { useMemo, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { MacroSummary } from "../../components/MacroSummary";
import { MealSection } from "../../components/MealSection";
import { trpc } from "../../lib/trpc";
import { useRefresh } from "../../lib/useRefresh";
import { colors } from "../../theme";
import { type FoodEntryRow, FoodEntrySchema } from "../../types/api";

const MEALS = [
  { key: "breakfast", label: "Breakfast" },
  { key: "lunch", label: "Lunch" },
  { key: "dinner", label: "Dinner" },
  { key: "snack", label: "Snack" },
  { key: "other", label: "Other" },
] as const;

function formatDateForQuery(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatDateForDisplay(date: Date): string {
  return date.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
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
  const dateString = formatDateForQuery(selectedDate);

  const calorieGoalQuery = trpc.settings.get.useQuery({ key: "calorieGoal" });
  const calorieGoal = typeof calorieGoalQuery.data?.value === "number" ? calorieGoalQuery.data.value : 2000;

  const foodQuery = trpc.food.byDate.useQuery({ date: dateString });
  const deleteMutation = trpc.food.delete.useMutation({
    onSuccess: () => foodQuery.refetch(),
  });

  const entries = FoodEntrySchema.array().catch([]).parse(foodQuery.data ?? []);

  const dailyTotals = useMemo(() => {
    let totalCalories = 0;
    let totalProtein = 0;
    let totalCarbs = 0;
    let totalFat = 0;
    for (const entry of entries) {
      totalCalories += entry.calories ?? 0;
      totalProtein += entry.protein_g ?? 0;
      totalCarbs += entry.carbs_g ?? 0;
      totalFat += entry.fat_g ?? 0;
    }
    return { totalCalories, totalProtein, totalCarbs, totalFat };
  }, [entries]);

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

  function handleDeleteFood(id: string) {
    deleteMutation.mutate({ id });
  }

  const { refreshing, onRefresh } = useRefresh();

  return (
    <View style={styles.container}>
      <ScrollView style={styles.scrollView} contentContainerStyle={styles.content} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.textSecondary} />}>
        {/* Date navigation */}
        <View style={styles.dateNav}>
          <TouchableOpacity onPress={goToPreviousDay} style={styles.dateArrow}>
            <Text style={styles.dateArrowText}>{"\u2039"}</Text>
          </TouchableOpacity>
          <Text style={styles.dateHeader}>{formatDateForDisplay(selectedDate)}</Text>
          <TouchableOpacity onPress={goToNextDay} style={styles.dateArrow}>
            <Text style={styles.dateArrowText}>{"\u203A"}</Text>
          </TouchableOpacity>
        </View>

        {/* Section links */}
        <View style={styles.sectionLinksRow}>
          <TouchableOpacity
            onPress={() => router.push("/nutrition-analytics")}
            style={styles.sectionLinkButton}
          >
            <Text style={styles.sectionLinkText}>Analytics</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => router.push("/supplements")}
            style={styles.sectionLinkButton}
          >
            <Text style={styles.sectionLinkText}>Supplements</Text>
          </TouchableOpacity>
        </View>

        {!isToday(selectedDate) && (
          <TouchableOpacity onPress={() => setSelectedDate(new Date())} style={styles.todayButton}>
            <Text style={styles.todayButtonText}>Go to Today</Text>
          </TouchableOpacity>
        )}

        <MacroSummary
          calories={dailyTotals.totalCalories}
          caloriesGoal={calorieGoal}
          proteinGrams={Math.round(dailyTotals.totalProtein)}
          carbsGrams={Math.round(dailyTotals.totalCarbs)}
          fatGrams={Math.round(dailyTotals.totalFat)}
        />

        {foodQuery.isLoading ? (
          <Text style={styles.loadingText}>Loading...</Text>
        ) : (
          MEALS.map(({ key, label }) => (
            <MealSection
              key={key}
              mealName={label}
              mealKey={key}
              entries={mealGroups.get(key) ?? []}
              onAddFood={handleAddFood}
              onDeleteFood={handleDeleteFood}
              deleting={deleteMutation.isPending}
            />
          ))
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  scrollView: {
    flex: 1,
  },
  content: {
    padding: 16,
    paddingBottom: 100,
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
  loadingText: {
    textAlign: "center",
    color: colors.textTertiary,
    paddingVertical: 24,
  },
});
