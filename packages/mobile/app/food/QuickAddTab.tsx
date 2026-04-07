import { MEAL_OPTIONS, type MealType } from "@dofek/nutrition/meal";
import { ScrollView, Text, TextInput, TouchableOpacity, View } from "react-native";
import { colors } from "../../theme";
import { styles } from "./add-styles.ts";

interface QuickAddTabProps {
  foodName: string;
  onFoodNameChange: (value: string) => void;
  selectedMeal: MealType;
  onMealChange: (value: MealType) => void;
  calories: string;
  onCaloriesChange: (value: string) => void;
  proteinGrams: string;
  onProteinChange: (value: string) => void;
  carbsGrams: string;
  onCarbsChange: (value: string) => void;
  fatGrams: string;
  onFatChange: (value: string) => void;
  isWide: boolean;
  isSaving: boolean;
  onSave: () => void;
}

export function QuickAddTab({
  foodName,
  onFoodNameChange,
  selectedMeal,
  onMealChange,
  calories,
  onCaloriesChange,
  proteinGrams,
  onProteinChange,
  carbsGrams,
  onCarbsChange,
  fatGrams,
  onFatChange,
  isWide,
  isSaving,
  onSave,
}: QuickAddTabProps) {
  return (
    <ScrollView
      style={styles.scrollView}
      contentContainerStyle={[styles.formContent, isWide && styles.contentWide]}
      keyboardShouldPersistTaps="handled"
    >
      {/* Food name */}
      <TextInput
        style={styles.quickAddNameInput}
        value={foodName}
        onChangeText={onFoodNameChange}
        placeholder="Food name (optional)"
        placeholderTextColor={colors.textTertiary}
        selectTextOnFocus
      />

      {/* Meal selector */}
      <View style={styles.mealSelector}>
        {MEAL_OPTIONS.map(({ value, label }) => (
          <TouchableOpacity
            key={value}
            style={[styles.mealChip, selectedMeal === value && styles.mealChipSelected]}
            onPress={() => onMealChange(value)}
            activeOpacity={0.7}
          >
            <Text
              style={[styles.mealChipText, selectedMeal === value && styles.mealChipTextSelected]}
            >
              {label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Calories — big centered input */}
      <View style={styles.quickAddCalorieSection}>
        <TextInput
          style={styles.quickAddCalorieInput}
          value={calories}
          onChangeText={onCaloriesChange}
          placeholder="0"
          placeholderTextColor={colors.textTertiary}
          keyboardType="number-pad"
          autoFocus
        />
        <Text style={styles.quickAddCalorieUnit}>cal</Text>
      </View>

      {/* Macros — optional row */}
      <View style={styles.macroRow}>
        <View style={styles.macroField}>
          <View style={styles.macroLabelRow}>
            <View style={[styles.macroDot, { backgroundColor: colors.positive }]} />
            <Text style={styles.macroLabel}>Protein</Text>
          </View>
          <TextInput
            style={styles.macroInput}
            value={proteinGrams}
            onChangeText={onProteinChange}
            placeholder="g"
            placeholderTextColor={colors.textTertiary}
            keyboardType="numeric"
          />
        </View>
        <View style={styles.macroField}>
          <View style={styles.macroLabelRow}>
            <View style={[styles.macroDot, { backgroundColor: colors.warning }]} />
            <Text style={styles.macroLabel}>Carbs</Text>
          </View>
          <TextInput
            style={styles.macroInput}
            value={carbsGrams}
            onChangeText={onCarbsChange}
            placeholder="g"
            placeholderTextColor={colors.textTertiary}
            keyboardType="numeric"
          />
        </View>
        <View style={styles.macroField}>
          <View style={styles.macroLabelRow}>
            <View style={[styles.macroDot, { backgroundColor: colors.danger }]} />
            <Text style={styles.macroLabel}>Fat</Text>
          </View>
          <TextInput
            style={styles.macroInput}
            value={fatGrams}
            onChangeText={onFatChange}
            placeholder="g"
            placeholderTextColor={colors.textTertiary}
            keyboardType="numeric"
          />
        </View>
      </View>

      {/* Log button */}
      <TouchableOpacity
        style={[styles.saveButton, { marginTop: 16 }, isSaving && styles.saveButtonDisabled]}
        onPress={onSave}
        activeOpacity={0.8}
        disabled={isSaving}
      >
        <Text style={styles.saveButtonText}>{isSaving ? "Saving..." : "Log"}</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}
