import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { colors } from "../theme";
import type { FoodEntry } from "./FoodEntryCard";
import { FoodEntryCard } from "./FoodEntryCard";

interface MealSectionProps {
  mealName: string;
  mealKey: string;
  entries: FoodEntry[];
  onAddFood: (mealKey: string) => void;
  onDeleteFood: (id: string) => void;
  deleting: boolean;
}

export function MealSection({
  mealName,
  mealKey,
  entries,
  onAddFood,
  onDeleteFood,
  deleting,
}: MealSectionProps) {
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

      <TouchableOpacity
        style={styles.addButton}
        onPress={() => onAddFood(mealKey)}
        activeOpacity={0.7}
      >
        <Text style={styles.addButtonText}>+ Add food</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.surface,
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
    color: colors.text,
  },
  totalCalories: {
    fontSize: 14,
    fontWeight: "600",
    color: colors.textSecondary,
  },
  emptyText: {
    fontSize: 14,
    color: colors.textTertiary,
    fontStyle: "italic",
    paddingVertical: 8,
  },
  addButton: {
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.surfaceSecondary,
    marginTop: 4,
  },
  addButtonText: {
    fontSize: 14,
    color: colors.accent,
    fontWeight: "500",
  },
});
