import { Text, TouchableOpacity, View } from "react-native";
import { styles } from "./add-styles.ts";
import type { SearchResult } from "./add-types.ts";

interface FoodResultCardProps {
  result: SearchResult;
  onSelect: (result: SearchResult) => void;
  /** Override source label (e.g., always show "Open Food Facts" for OFF results) */
  sourceLabel?: string;
}

export function FoodResultCard({ result, onSelect, sourceLabel }: FoodResultCardProps) {
  const macroTags = [
    result.proteinG != null ? `Protein ${result.proteinG}g` : null,
    result.carbsG != null ? `Carbs ${result.carbsG}g` : null,
    result.fatG != null ? `Fat ${result.fatG}g` : null,
  ].filter((tag): tag is string => tag !== null);

  return (
    <TouchableOpacity
      key={`${result.source}-${result.name}`}
      style={styles.resultCard}
      onPress={() => onSelect(result)}
      activeOpacity={0.75}
    >
      <View style={styles.resultHeaderRow}>
        <Text style={styles.resultName} numberOfLines={2}>
          {result.name}
        </Text>
        {result.calories != null && (
          <View style={styles.resultCaloriesBadge}>
            <Text style={styles.resultCaloriesText}>{result.calories} cal</Text>
          </View>
        )}
      </View>

      {result.servingDescription && (
        <Text style={styles.resultServing} numberOfLines={2}>
          {result.servingDescription}
        </Text>
      )}

      <View style={styles.resultMetaRow}>
        <View style={styles.resultMacroTags}>
          {macroTags.map((macro) => (
            <View key={`${result.name}-${macro}`} style={styles.resultMacroTag}>
              <Text style={styles.resultMacroTagText}>{macro}</Text>
            </View>
          ))}
        </View>
        <Text style={styles.resultSource}>
          {sourceLabel ?? (result.source === "history" ? "History" : "Open Food Facts")}
        </Text>
      </View>
    </TouchableOpacity>
  );
}
