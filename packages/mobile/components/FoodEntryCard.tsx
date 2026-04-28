import { Alert, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { colors } from "../theme";

export interface FoodEntry {
  id: string;
  food_name: string | null;
  food_description: string | null;
  meal: string | null;
  calories: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
}

interface FoodEntryCardProps {
  entry: FoodEntry;
  onDelete: (id: string) => void;
  deleting: boolean;
}

export function FoodEntryCard({ entry, onDelete, deleting }: FoodEntryCardProps) {
  const displayName = entry.food_name ?? "Unnamed nutrition entry";

  function handleLongPress() {
    Alert.alert("Delete Entry", `Remove "${displayName}"?`, [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: () => onDelete(entry.id) },
    ]);
  }

  return (
    <TouchableOpacity
      style={[styles.container, deleting && styles.deleting]}
      activeOpacity={0.7}
      onLongPress={handleLongPress}
    >
      <View style={styles.leftSection}>
        <Text style={styles.name}>{displayName}</Text>
        {entry.food_description ? (
          <Text style={styles.description}>{entry.food_description}</Text>
        ) : null}
        <Text style={styles.macros}>
          Protein: {entry.protein_g ?? 0}g · Carbs: {entry.carbs_g ?? 0}g · Fat: {entry.fat_g ?? 0}g
        </Text>
      </View>
      <Text style={styles.calories}>{entry.calories ?? 0} cal</Text>
    </TouchableOpacity>
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
  deleting: {
    opacity: 0.5,
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
