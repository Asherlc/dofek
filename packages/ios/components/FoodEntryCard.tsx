import { Alert, StyleSheet, Text, TouchableOpacity, View } from "react-native";

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
  onDelete: (id: string) => void;
  deleting: boolean;
}

export function FoodEntryCard({ entry, onDelete, deleting }: FoodEntryCardProps) {
  function handleLongPress() {
    Alert.alert("Delete Entry", `Remove "${entry.food_name}"?`, [
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
        <Text style={styles.name}>{entry.food_name}</Text>
        {entry.food_description ? (
          <Text style={styles.description}>{entry.food_description}</Text>
        ) : null}
        <Text style={styles.macros}>
          P: {entry.protein_g ?? 0}g · C: {entry.carbs_g ?? 0}g · F: {entry.fat_g ?? 0}g
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
    borderBottomColor: "#eee",
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
    color: "#1a1a1a",
    fontWeight: "500",
  },
  description: {
    fontSize: 12,
    color: "#888",
    marginTop: 1,
  },
  macros: {
    fontSize: 12,
    color: "#999",
    marginTop: 2,
  },
  calories: {
    fontSize: 16,
    fontWeight: "600",
    color: "#666",
  },
});
