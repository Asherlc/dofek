import { MEAL_OPTIONS, type MealType } from "@dofek/nutrition/meal";
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { styles } from "./add-styles.ts";

interface FoodDetailFormProps {
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
  servingDescription: string;
  isWide: boolean;
  isSaving: boolean;
  onBack: () => void;
  onSave: () => void;
}

export function FoodDetailForm({
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
  servingDescription,
  isWide,
  isSaving,
  onBack,
  onSave,
}: FoodDetailFormProps) {
  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={[styles.formContent, isWide && styles.contentWide]}
      >
        {/* Food name (editable) */}
        <Text style={styles.label}>Name</Text>
        <TextInput
          style={styles.input}
          value={foodName}
          onChangeText={onFoodNameChange}
          placeholder="Food name"
          placeholderTextColor="#999"
        />

        {/* Meal selector */}
        <Text style={styles.label}>Meal</Text>
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

        {/* Calories — large prominent field */}
        <Text style={styles.label}>Calories *</Text>
        <TextInput
          style={[styles.input, styles.calorieInput]}
          value={calories}
          onChangeText={onCaloriesChange}
          placeholder="0"
          placeholderTextColor="#999"
          keyboardType="numeric"
        />

        {/* Serving description */}
        {servingDescription ? <Text style={styles.servingHint}>{servingDescription}</Text> : null}

        {/* Macros — compact row */}
        <View style={styles.macroRow}>
          <View style={styles.macroField}>
            <Text style={styles.macroLabel}>Protein</Text>
            <TextInput
              style={styles.macroInput}
              value={proteinGrams}
              onChangeText={onProteinChange}
              placeholder="g"
              placeholderTextColor="#bbb"
              keyboardType="numeric"
            />
          </View>
          <View style={styles.macroField}>
            <Text style={styles.macroLabel}>Carbs</Text>
            <TextInput
              style={styles.macroInput}
              value={carbsGrams}
              onChangeText={onCarbsChange}
              placeholder="g"
              placeholderTextColor="#bbb"
              keyboardType="numeric"
            />
          </View>
          <View style={styles.macroField}>
            <Text style={styles.macroLabel}>Fat</Text>
            <TextInput
              style={styles.macroInput}
              value={fatGrams}
              onChangeText={onFatChange}
              placeholder="g"
              placeholderTextColor="#bbb"
              keyboardType="numeric"
            />
          </View>
        </View>

        {/* Action buttons */}
        <View style={styles.formButtons}>
          <TouchableOpacity style={styles.backButton} onPress={onBack} activeOpacity={0.7}>
            <Text style={styles.backButtonText}>Back</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.saveButton, { flex: 2 }, isSaving && styles.saveButtonDisabled]}
            onPress={onSave}
            activeOpacity={0.8}
            disabled={isSaving}
          >
            <Text style={styles.saveButtonText}>{isSaving ? "Saving..." : "Log Food"}</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
