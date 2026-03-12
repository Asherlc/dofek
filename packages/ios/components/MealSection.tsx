import { StyleSheet, Text, View } from "react-native";
import { FoodEntryCard } from "./FoodEntryCard";
import type { FoodEntry } from "./FoodEntryCard";

interface MealSectionProps {
  mealName: string;
  entries: FoodEntry[];
}

export function MealSection({ mealName, entries }: MealSectionProps) {
  const totalCalories = entries.reduce((sum, entry) => sum + entry.calories, 0);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.mealName}>{mealName}</Text>
        <Text style={styles.totalCalories}>{totalCalories} cal</Text>
      </View>

      {entries.length > 0 ? (
        entries.map((entry) => <FoodEntryCard key={entry.id} entry={entry} />)
      ) : (
        <Text style={styles.emptyText}>No entries yet</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: "#fff",
    borderRadius: 12,
    padding: 12,
    marginBottom: 12,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 2,
    elevation: 1,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 4,
  },
  mealName: {
    fontSize: 16,
    fontWeight: "700",
    color: "#1a1a1a",
  },
  totalCalories: {
    fontSize: 14,
    fontWeight: "600",
    color: "#666",
  },
  emptyText: {
    fontSize: 14,
    color: "#ccc",
    fontStyle: "italic",
    paddingVertical: 8,
  },
});
