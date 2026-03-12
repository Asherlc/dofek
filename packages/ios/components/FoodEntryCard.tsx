import { StyleSheet, Text, TouchableOpacity, View } from "react-native";

export interface FoodEntry {
  id: string;
  name: string;
  calories: number;
  proteinGrams: number;
  carbsGrams: number;
  fatGrams: number;
}

interface FoodEntryCardProps {
  entry: FoodEntry;
}

// TODO: Add swipe-to-delete, tap to edit
export function FoodEntryCard({ entry }: FoodEntryCardProps) {
  return (
    <TouchableOpacity style={styles.container} activeOpacity={0.7}>
      <View style={styles.leftSection}>
        <Text style={styles.name}>{entry.name}</Text>
        <Text style={styles.macros}>
          P: {entry.proteinGrams}g &middot; C: {entry.carbsGrams}g &middot; F: {entry.fatGrams}g
        </Text>
      </View>
      <Text style={styles.calories}>{entry.calories} cal</Text>
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
  leftSection: {
    flex: 1,
    marginRight: 12,
  },
  name: {
    fontSize: 16,
    color: "#1a1a1a",
    fontWeight: "500",
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
