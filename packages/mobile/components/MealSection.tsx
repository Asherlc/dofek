import { formatCalories } from "@dofek/format/format";
import { StyleSheet, Text, View } from "react-native";
import { colors } from "../theme";
import type { FoodEntry } from "./FoodEntryCard";
import { FoodEntryCard } from "./FoodEntryCard";

interface MealSectionProps {
  mealName: string;
  entries: FoodEntry[];
  totalCalories: number | null;
}

export function MealSection({ mealName, entries, totalCalories }: MealSectionProps) {
  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.mealName}>{mealName}</Text>
        <Text style={styles.totalCalories}>
          {totalCalories != null && totalCalories > 0 ? formatCalories(totalCalories) : ""}
        </Text>
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
});
