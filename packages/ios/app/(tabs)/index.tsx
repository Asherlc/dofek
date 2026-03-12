import { useRouter } from "expo-router";
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { MacroSummary } from "../../components/MacroSummary";
import { MealSection } from "../../components/MealSection";

// TODO: Replace with real data from tRPC queries
const PLACEHOLDER_SUMMARY = {
  calories: 1850,
  caloriesGoal: 2400,
  proteinGrams: 120,
  carbsGrams: 200,
  fatGrams: 65,
};

const PLACEHOLDER_MEALS = [
  {
    name: "Breakfast" as const,
    entries: [
      { id: "1", name: "Oatmeal with berries", calories: 350, proteinGrams: 12, carbsGrams: 55, fatGrams: 8 },
      { id: "2", name: "Coffee with milk", calories: 50, proteinGrams: 2, carbsGrams: 4, fatGrams: 3 },
    ],
  },
  {
    name: "Lunch" as const,
    entries: [
      { id: "3", name: "Chicken salad", calories: 500, proteinGrams: 40, carbsGrams: 20, fatGrams: 28 },
    ],
  },
  {
    name: "Dinner" as const,
    entries: [],
  },
  {
    name: "Snacks" as const,
    entries: [
      { id: "4", name: "Protein bar", calories: 200, proteinGrams: 20, carbsGrams: 25, fatGrams: 8 },
    ],
  },
];

function formatDate(date: Date): string {
  return date.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

export default function TodayScreen() {
  const router = useRouter();
  const today = new Date();

  return (
    <View style={styles.container}>
      <ScrollView style={styles.scrollView} contentContainerStyle={styles.content}>
        <Text style={styles.dateHeader}>{formatDate(today)}</Text>

        <MacroSummary
          calories={PLACEHOLDER_SUMMARY.calories}
          caloriesGoal={PLACEHOLDER_SUMMARY.caloriesGoal}
          proteinGrams={PLACEHOLDER_SUMMARY.proteinGrams}
          carbsGrams={PLACEHOLDER_SUMMARY.carbsGrams}
          fatGrams={PLACEHOLDER_SUMMARY.fatGrams}
        />

        {PLACEHOLDER_MEALS.map((meal) => (
          <MealSection key={meal.name} mealName={meal.name} entries={meal.entries} />
        ))}
      </ScrollView>

      {/* TODO: Replace with proper FAB component */}
      <TouchableOpacity
        style={styles.fab}
        onPress={() => router.push("/food/add")}
        activeOpacity={0.8}
      >
        <Text style={styles.fabText}>+</Text>
      </TouchableOpacity>
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
  dateHeader: {
    fontSize: 24,
    fontWeight: "700",
    marginBottom: 16,
    color: "#1a1a1a",
  },
  fab: {
    position: "absolute",
    bottom: 24,
    right: 24,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: "#007AFF",
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
    elevation: 5,
  },
  fabText: {
    fontSize: 28,
    color: "#fff",
    fontWeight: "600",
    lineHeight: 30,
  },
});
