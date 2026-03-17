import { useRouter } from "expo-router";
import { useMemo, useState } from "react";
import { ScrollView, StyleSheet, Text, TouchableOpacity, View, useWindowDimensions } from "react-native";
import type { FoodEntry } from "../../components/FoodEntryCard";
import { MacroSummary } from "../../components/MacroSummary";
import { MealSection } from "../../components/MealSection";
import { trpc } from "../../lib/trpc";

/** Narrow loosely-typed tRPC raw-SQL results to a known shape without double-casting. */
function typedData<T>(data: unknown): T {
  return data as T;
}

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

export default function TodayScreen() {
  const router = useRouter();
  const [selectedDate, setSelectedDate] = useState(() => new Date());
  const dateString = formatDateForQuery(selectedDate);

  const calorieGoalQuery = trpc.settings.get.useQuery({ key: "calorieGoal" });
  const calorieGoal = (calorieGoalQuery.data?.value as number) ?? 2000;

  const foodQuery = trpc.food.byDate.useQuery({ date: dateString });
  const deleteMutation = trpc.food.delete.useMutation({
    onSuccess: () => foodQuery.refetch(),
  });

  const entries = typedData<FoodEntry[]>(foodQuery.data ?? []);

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
    const groups = new Map<string, FoodEntry[]>();
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

  const { width } = useWindowDimensions();
  const isWide = width >= 600;

  return (
    <View style={styles.container}>
      <ScrollView style={styles.scrollView} contentContainerStyle={[styles.content, isWide && styles.contentWide]}>
        {/* Date navigation */}
        <View style={styles.dateNav}>
          <TouchableOpacity onPress={goToPreviousDay} style={styles.dateArrow}>
            <Text style={styles.dateArrowText}>‹</Text>
          </TouchableOpacity>
          <Text style={styles.dateHeader}>{formatDateForDisplay(selectedDate)}</Text>
          <TouchableOpacity onPress={goToNextDay} style={styles.dateArrow}>
            <Text style={styles.dateArrowText}>›</Text>
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
    backgroundColor: "#f8f9fa",
  },
  scrollView: {
    flex: 1,
  },
  content: {
    padding: 16,
    paddingBottom: 100,
  },
  contentWide: {
    maxWidth: 600,
    alignSelf: "center",
    width: "100%",
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
    color: "#007AFF",
    fontWeight: "300",
  },
  dateHeader: {
    fontSize: 20,
    fontWeight: "700",
    color: "#1a1a1a",
  },
  todayButton: {
    alignSelf: "center",
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#007AFF",
    marginBottom: 12,
  },
  todayButtonText: {
    fontSize: 13,
    color: "#007AFF",
    fontWeight: "500",
  },
  loadingText: {
    textAlign: "center",
    color: "#999",
    paddingVertical: 24,
  },
});
