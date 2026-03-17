import { useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  TouchableWithoutFeedback,
  View,
} from "react-native";
import { type MealType, autoMealType, formatDateYmd } from "../lib/meal";
import { colors } from "../theme";
import { trpc } from "../lib/trpc";

const MEAL_OPTIONS: { key: MealType; label: string }[] = [
  { key: "breakfast", label: "Breakfast" },
  { key: "lunch", label: "Lunch" },
  { key: "dinner", label: "Dinner" },
  { key: "snack", label: "Snack" },
];

interface QuickAddFoodProps {
  visible: boolean;
  onClose: () => void;
}

export function QuickAddFood({ visible, onClose }: QuickAddFoodProps) {
  const [foodName, setFoodName] = useState("Quick Add");
  const [selectedMeal, setSelectedMeal] = useState<MealType>(autoMealType);
  const [calories, setCalories] = useState("");
  const [proteinGrams, setProteinGrams] = useState("");
  const [carbsGrams, setCarbsGrams] = useState("");
  const [fatGrams, setFatGrams] = useState("");

  const utils = trpc.useUtils();
  const date = formatDateYmd();

  const quickAddMutation = trpc.food.quickAdd.useMutation({
    onSuccess: () => {
      utils.food.byDate.invalidate({ date });
      resetAndClose();
    },
    onError: (error) => {
      Alert.alert("Error", error.message);
    },
  });

  function resetAndClose() {
    setFoodName("Quick Add");
    setSelectedMeal(autoMealType());
    setCalories("");
    setProteinGrams("");
    setCarbsGrams("");
    setFatGrams("");
    onClose();
  }

  function handleSave() {
    const parsedCalories = Number.parseInt(calories, 10);
    if (Number.isNaN(parsedCalories) || parsedCalories <= 0) {
      Alert.alert("Missing field", "Enter a calorie amount.");
      return;
    }

    quickAddMutation.mutate({
      date,
      meal: selectedMeal,
      foodName: foodName.trim() || "Quick Add",
      calories: parsedCalories,
      proteinG: proteinGrams ? Number.parseFloat(proteinGrams) : null,
      carbsG: carbsGrams ? Number.parseFloat(carbsGrams) : null,
      fatG: fatGrams ? Number.parseFloat(fatGrams) : null,
    });
  }

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={resetAndClose}
    >
      <TouchableWithoutFeedback onPress={resetAndClose}>
        <View style={styles.backdrop} />
      </TouchableWithoutFeedback>

      <KeyboardAvoidingView
        style={styles.sheetWrapper}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <View style={styles.sheet}>
          {/* Drag handle */}
          <View style={styles.handle} />

          <Text style={styles.title}>Quick Add</Text>

          {/* Food name */}
          <TextInput
            style={styles.nameInput}
            value={foodName}
            onChangeText={setFoodName}
            placeholder="Food name"
            placeholderTextColor={colors.textTertiary}
            selectTextOnFocus
          />

          {/* Meal selector */}
          <View style={styles.mealRow}>
            {MEAL_OPTIONS.map(({ key, label }) => (
              <TouchableOpacity
                key={key}
                style={[
                  styles.mealChip,
                  selectedMeal === key && styles.mealChipSelected,
                ]}
                onPress={() => setSelectedMeal(key)}
                activeOpacity={0.7}
              >
                <Text
                  style={[
                    styles.mealChipText,
                    selectedMeal === key && styles.mealChipTextSelected,
                  ]}
                >
                  {label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {/* Calories — big input */}
          <View style={styles.calorieSection}>
            <TextInput
              style={styles.calorieInput}
              value={calories}
              onChangeText={setCalories}
              placeholder="0"
              placeholderTextColor={colors.textTertiary}
              keyboardType="number-pad"
              autoFocus
            />
            <Text style={styles.calorieUnit}>cal</Text>
          </View>

          {/* Macros — optional row */}
          <View style={styles.macroRow}>
            <MacroField
              label="Protein"
              value={proteinGrams}
              onChangeText={setProteinGrams}
              color={colors.positive}
            />
            <MacroField
              label="Carbs"
              value={carbsGrams}
              onChangeText={setCarbsGrams}
              color={colors.warning}
            />
            <MacroField
              label="Fat"
              value={fatGrams}
              onChangeText={setFatGrams}
              color={colors.danger}
            />
          </View>

          {/* Save button */}
          <TouchableOpacity
            style={[
              styles.saveButton,
              quickAddMutation.isPending && styles.saveButtonDisabled,
            ]}
            onPress={handleSave}
            activeOpacity={0.8}
            disabled={quickAddMutation.isPending}
          >
            <Text style={styles.saveButtonText}>
              {quickAddMutation.isPending ? "Saving..." : "Log"}
            </Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function MacroField({
  label,
  value,
  onChangeText,
  color,
}: {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  color: string;
}) {
  return (
    <View style={styles.macroField}>
      <View style={styles.macroLabelRow}>
        <View style={[styles.macroDot, { backgroundColor: color }]} />
        <Text style={styles.macroLabel}>{label}</Text>
      </View>
      <TextInput
        style={styles.macroInput}
        value={value}
        onChangeText={onChangeText}
        placeholder="g"
        placeholderTextColor={colors.textTertiary}
        keyboardType="numeric"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
  },
  sheetWrapper: {
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 20,
    paddingBottom: 40,
    gap: 16,
  },
  handle: {
    width: 36,
    height: 4,
    backgroundColor: colors.surfaceSecondary,
    borderRadius: 2,
    alignSelf: "center",
    marginBottom: 4,
  },
  title: {
    fontSize: 18,
    fontWeight: "700",
    color: colors.text,
    textAlign: "center",
  },
  nameInput: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 16,
    color: colors.text,
  },
  mealRow: {
    flexDirection: "row",
    justifyContent: "center",
    gap: 8,
  },
  mealChip: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 18,
    backgroundColor: colors.surfaceSecondary,
  },
  mealChipSelected: {
    backgroundColor: colors.accent,
  },
  mealChipText: {
    fontSize: 14,
    color: colors.textSecondary,
    fontWeight: "500",
  },
  mealChipTextSelected: {
    color: colors.text,
  },
  calorieSection: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "center",
    gap: 4,
  },
  calorieInput: {
    fontSize: 48,
    fontWeight: "700",
    color: colors.text,
    textAlign: "center",
    minWidth: 120,
    fontVariant: ["tabular-nums"],
  },
  calorieUnit: {
    fontSize: 20,
    color: colors.textSecondary,
    fontWeight: "500",
  },
  macroRow: {
    flexDirection: "row",
    gap: 10,
  },
  macroField: {
    flex: 1,
    gap: 4,
  },
  macroLabelRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  macroDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  macroLabel: {
    fontSize: 12,
    color: colors.textSecondary,
    fontWeight: "600",
  },
  macroInput: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: 8,
    padding: 10,
    fontSize: 16,
    color: colors.text,
    textAlign: "center",
  },
  saveButton: {
    backgroundColor: colors.accent,
    borderRadius: 12,
    padding: 16,
    alignItems: "center",
    marginTop: 4,
  },
  saveButtonDisabled: {
    opacity: 0.5,
  },
  saveButtonText: {
    color: colors.text,
    fontSize: 17,
    fontWeight: "700",
  },
});
