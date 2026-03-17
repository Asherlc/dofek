import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { FoodEntryCard } from "./FoodEntryCard";
import type { FoodEntry } from "./FoodEntryCard";

interface MealSectionProps {
  mealName: string;
  mealKey: string;
  entries: FoodEntry[];
  onAddFood: (mealKey: string) => void;
  onDeleteFood: (id: string) => void;
  deleting: boolean;
}

export function MealSection({ mealName, mealKey, entries, onAddFood, onDeleteFood, deleting }: MealSectionProps) {
  const totalCalories = entries.reduce((sum, entry) => sum + (entry.calories ?? 0), 0);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.mealName}>{mealName}</Text>
        <Text style={styles.totalCalories}>{totalCalories > 0 ? `${totalCalories} cal` : ""}</Text>
      </View>

      {entries.length > 0 ? (
        entries.map((entry) => (
          <FoodEntryCard key={entry.id} entry={entry} onDelete={onDeleteFood} deleting={deleting} />
        ))
      ) : (
        <Text style={styles.emptyText}>No entries yet</Text>
      )}

      <TouchableOpacity style={styles.addButton} onPress={() => onAddFood(mealKey)} activeOpacity={0.7}>
        <Text style={styles.addButtonText}>+ Add food</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: "#1c1c1e",
    borderRadius: 16,
    padding: 12,
    marginBottom: 12,
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
    color: "#fff",
  },
  totalCalories: {
    fontSize: 14,
    fontWeight: "600",
    color: "#8e8e93",
  },
  emptyText: {
    fontSize: 14,
    color: "#636366",
    fontStyle: "italic",
    paddingVertical: 8,
  },
  addButton: {
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#2a2a2e",
    marginTop: 4,
  },
  addButtonText: {
    fontSize: 14,
    color: "#007AFF",
    fontWeight: "500",
  },
});
