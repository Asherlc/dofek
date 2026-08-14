import { useRouter } from "expo-router";
import { useMemo, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { MacroSummary } from "../../components/MacroSummary";
import { MealSection } from "../../components/MealSection";
import { safeParseRows } from "../../lib/safe-parse";
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

function dateString(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export default function FoodScreen() {
  const router = useRouter();
  const [selectedDate, setSelectedDate] = useState(() => new Date());
  const date = dateString(selectedDate);
  const calorieGoalQuery = trpc.settings.get.useQuery({ key: "calorieGoal" });
  const calorieGoal =
    typeof calorieGoalQuery.data?.value === "number" ? calorieGoalQuery.data.value : 2000;
  const foodQuery = trpc.food.byDate.useQuery({ date });
  const parsedEntries = safeParseRows(FoodEntrySchema, foodQuery.data, "food:byDate");
  const entries = parsedEntries.data;
  const totals = useMemo(
    () =>
      entries.reduce(
        (sum, entry) => ({
          calories: sum.calories + (entry.calories ?? 0),
          protein: sum.protein + (entry.protein_g ?? 0),
          carbs: sum.carbs + (entry.carbs_g ?? 0),
          fat: sum.fat + (entry.fat_g ?? 0),
        }),
        { calories: 0, protein: 0, carbs: 0, fat: 0 },
      ),
    [entries],
  );
  const meals = useMemo(() => {
    const grouped = new Map<string, FoodEntryRow[]>();
    for (const entry of entries)
      grouped.set(entry.meal || "other", [...(grouped.get(entry.meal || "other") ?? []), entry]);
    return grouped;
  }, [entries]);
  const { refreshing, onRefresh } = useRefresh();

  function shiftDate(days: number) {
    setSelectedDate(
      (current) => new Date(current.getFullYear(), current.getMonth(), current.getDate() + days),
    );
  }

  return (
    <View style={styles.container}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.textSecondary}
          />
        }
      >
        <View style={styles.dateNavigation}>
          <TouchableOpacity onPress={() => shiftDate(-1)}>
            <Text style={styles.arrow}>‹</Text>
          </TouchableOpacity>
          <Text style={styles.date}>
            {selectedDate.toLocaleDateString("en-US", {
              weekday: "long",
              month: "long",
              day: "numeric",
            })}
          </Text>
          <TouchableOpacity onPress={() => shiftDate(1)}>
            <Text style={styles.arrow}>›</Text>
          </TouchableOpacity>
        </View>
        <View style={styles.links}>
          <TouchableOpacity onPress={() => router.push("/nutrition-analytics")}>
            <Text style={styles.link}>Analytics</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => router.push("/supplements")}>
            <Text style={styles.link}>Supplements</Text>
          </TouchableOpacity>
        </View>
        <MacroSummary
          calories={totals.calories}
          caloriesGoal={calorieGoal}
          proteinGrams={Math.round(totals.protein)}
          carbsGrams={Math.round(totals.carbs)}
          fatGrams={Math.round(totals.fat)}
        />
        {foodQuery.isLoading ? (
          <Text style={styles.message}>Loading...</Text>
        ) : foodQuery.isError || parsedEntries.error ? (
          <Text style={styles.message}>Failed to load food entries.</Text>
        ) : (
          MEALS.map(({ key, label }) => (
            <MealSection key={key} mealName={label} entries={meals.get(key) ?? []} />
          ))
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  scroll: { flex: 1 },
  content: { padding: 16, paddingBottom: 100, gap: 12 },
  dateNavigation: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  date: { fontSize: 20, fontWeight: "700", color: colors.text },
  arrow: { fontSize: 28, color: colors.accent, padding: 8 },
  links: { flexDirection: "row", justifyContent: "center", gap: 16 },
  link: { color: colors.accent, fontWeight: "600" },
  message: { color: colors.textSecondary, textAlign: "center", padding: 24 },
});
