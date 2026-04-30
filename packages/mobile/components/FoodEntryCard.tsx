import {
  foodEntryNutrientDetailsFromLegacyColumns,
  groupFoodEntryNutrientDetails,
} from "@dofek/nutrition/food-entry-nutrition";
import { useState } from "react";
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
  [nutrientColumnName: string]: unknown;
}

interface FoodEntryCardProps {
  entry: FoodEntry;
  onDelete: (id: string) => void;
  deleting: boolean;
}

export function FoodEntryCard({ entry, onDelete, deleting }: FoodEntryCardProps) {
  const [expanded, setExpanded] = useState(false);
  const displayName = entry.food_name ?? "Unnamed nutrition entry";
  const nutrientDetails = foodEntryNutrientDetailsFromLegacyColumns(entry);
  const nutrientGroups = groupFoodEntryNutrientDetails(nutrientDetails);

  function handleLongPress() {
    Alert.alert("Delete Entry", `Remove "${displayName}"?`, [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: () => onDelete(entry.id) },
    ]);
  }

  return (
    <View style={styles.wrapper}>
      <TouchableOpacity
        style={[styles.container, deleting && styles.deleting]}
        activeOpacity={0.7}
        onPress={() => setExpanded((current) => !current)}
        onLongPress={handleLongPress}
      >
        <View style={styles.leftSection}>
          <Text style={styles.name}>{displayName}</Text>
          {entry.food_description ? (
            <Text style={styles.description}>{entry.food_description}</Text>
          ) : null}
          <Text style={styles.macros}>
            Protein: {entry.protein_g ?? 0}g · Carbs: {entry.carbs_g ?? 0}g · Fat:{" "}
            {entry.fat_g ?? 0}g
          </Text>
        </View>
        <Text style={styles.calories}>{entry.calories ?? 0} cal</Text>
      </TouchableOpacity>
      {expanded ? (
        <View style={styles.details}>
          {nutrientGroups.length > 0 ? (
            nutrientGroups.map((group) => (
              <View key={group.label} style={styles.detailGroup}>
                <Text style={styles.detailGroupTitle}>{group.label}</Text>
                <View style={styles.detailGrid}>
                  {group.nutrients.map((nutrient) => (
                    <View key={nutrient.id} style={styles.detailItem}>
                      <Text style={styles.detailLabel}>{nutrient.label}</Text>
                      <Text style={styles.detailValue}>{nutrient.valueText}</Text>
                    </View>
                  ))}
                </View>
              </View>
            ))
          ) : (
            <Text style={styles.emptyDetails}>No nutrient details recorded</Text>
          )}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.surfaceSecondary,
  },
  container: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 10,
    paddingHorizontal: 4,
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
  details: {
    backgroundColor: colors.background,
    borderRadius: 10,
    marginBottom: 10,
    marginHorizontal: 4,
    padding: 10,
    gap: 10,
  },
  detailGroup: {
    gap: 6,
  },
  detailGroupTitle: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "700",
  },
  detailGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  detailItem: {
    width: "48%",
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 6,
  },
  detailLabel: {
    color: colors.textSecondary,
    fontSize: 12,
    flexShrink: 1,
  },
  detailValue: {
    color: colors.text,
    fontSize: 12,
    fontWeight: "600",
  },
  emptyDetails: {
    color: colors.textSecondary,
    fontSize: 12,
  },
});
