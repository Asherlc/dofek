import { StyleSheet, Text, View } from "react-native";
import { colors } from "../theme";

export interface FoodEntry {
  id: string;
  food_name: string;
  food_description: string | null;
  meal: string;
  calories: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
}

interface FoodEntryCardProps {
  entry: FoodEntry;
}

export function FoodEntryCard({ entry }: FoodEntryCardProps) {
  return (
    <View style={styles.container}>
      <View style={styles.leftSection}>
        <Text style={styles.name}>{entry.food_name}</Text>
        {entry.food_description ? (
          <Text style={styles.description}>{entry.food_description}</Text>
        ) : null}
        <Text style={styles.macros}>
          Protein: {entry.protein_g ?? 0}g · Carbs: {entry.carbs_g ?? 0}g · Fat: {entry.fat_g ?? 0}g
        </Text>
      </View>
      <Text style={styles.calories}>{entry.calories ?? 0} cal</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 10,
    paddingHorizontal: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.surfaceSecondary,
  },
  leftSection: {
    flex: 1,
    marginRight: 12,
  },
  name: {
    fontSize: 16,
    color: colors.text,
    fontWeight: "500",
  },
  description: {
    fontSize: 12,
    color: colors.textTertiary,
    marginTop: 1,
  },
  macros: {
    fontSize: 12,
    color: colors.textSecondary,
    marginTop: 2,
  },
  calories: {
    fontSize: 16,
    fontWeight: "600",
    color: colors.textSecondary,
  },
});
