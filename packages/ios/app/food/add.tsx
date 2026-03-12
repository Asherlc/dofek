import { useRouter } from "expo-router";
import { useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";

type MealType = "Breakfast" | "Lunch" | "Dinner" | "Snacks";

const MEAL_OPTIONS: MealType[] = ["Breakfast", "Lunch", "Dinner", "Snacks"];

// TODO: Implement barcode scanner (expo-camera or expo-barcode-scanner)
// TODO: Implement food database search (USDA FoodData Central API or similar)
// TODO: Wire up save to tRPC mutation
// TODO: Add form validation

export default function AddFoodScreen() {
  const router = useRouter();
  const [foodName, setFoodName] = useState("");
  const [selectedMeal, setSelectedMeal] = useState<MealType>("Lunch");
  const [calories, setCalories] = useState("");
  const [proteinGrams, setProteinGrams] = useState("");
  const [carbsGrams, setCarbsGrams] = useState("");
  const [fatGrams, setFatGrams] = useState("");

  function handleSave() {
    // TODO: Validate inputs and save via tRPC mutation
    console.log("Save food entry:", {
      foodName,
      meal: selectedMeal,
      calories: Number(calories),
      proteinGrams: Number(proteinGrams),
      carbsGrams: Number(carbsGrams),
      fatGrams: Number(fatGrams),
    });
    router.back();
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      <ScrollView style={styles.scrollView} contentContainerStyle={styles.content}>
        {/* TODO: Replace with actual food database search */}
        <Text style={styles.sectionTitle}>Search Food</Text>
        <TextInput
          style={styles.searchInput}
          placeholder="Search food database..."
          placeholderTextColor="#999"
          editable={false}
        />
        <Text style={styles.searchHint}>Food database search coming soon</Text>

        <Text style={styles.sectionTitle}>Food Details</Text>

        <Text style={styles.label}>Name</Text>
        <TextInput
          style={styles.input}
          value={foodName}
          onChangeText={setFoodName}
          placeholder="e.g. Chicken breast"
          placeholderTextColor="#999"
        />

        <Text style={styles.label}>Meal</Text>
        <View style={styles.mealSelector}>
          {MEAL_OPTIONS.map((meal) => (
            <TouchableOpacity
              key={meal}
              style={[styles.mealOption, selectedMeal === meal && styles.mealOptionSelected]}
              onPress={() => setSelectedMeal(meal)}
              activeOpacity={0.7}
            >
              <Text
                style={[
                  styles.mealOptionText,
                  selectedMeal === meal && styles.mealOptionTextSelected,
                ]}
              >
                {meal}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        <Text style={styles.label}>Calories</Text>
        <TextInput
          style={styles.input}
          value={calories}
          onChangeText={setCalories}
          placeholder="0"
          placeholderTextColor="#999"
          keyboardType="numeric"
        />

        <View style={styles.macroRow}>
          <View style={styles.macroField}>
            <Text style={styles.label}>Protein (g)</Text>
            <TextInput
              style={styles.input}
              value={proteinGrams}
              onChangeText={setProteinGrams}
              placeholder="0"
              placeholderTextColor="#999"
              keyboardType="numeric"
            />
          </View>
          <View style={styles.macroField}>
            <Text style={styles.label}>Carbs (g)</Text>
            <TextInput
              style={styles.input}
              value={carbsGrams}
              onChangeText={setCarbsGrams}
              placeholder="0"
              placeholderTextColor="#999"
              keyboardType="numeric"
            />
          </View>
          <View style={styles.macroField}>
            <Text style={styles.label}>Fat (g)</Text>
            <TextInput
              style={styles.input}
              value={fatGrams}
              onChangeText={setFatGrams}
              placeholder="0"
              placeholderTextColor="#999"
              keyboardType="numeric"
            />
          </View>
        </View>

        <TouchableOpacity style={styles.saveButton} onPress={handleSave} activeOpacity={0.8}>
          <Text style={styles.saveButtonText}>Save</Text>
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#f8f9fa",
  },
  scrollView: {
    flex: 1,
  },
  content: {
    padding: 16,
    paddingBottom: 40,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: "#1a1a1a",
    marginTop: 16,
    marginBottom: 8,
  },
  searchInput: {
    backgroundColor: "#e9ecef",
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
    color: "#999",
  },
  searchHint: {
    fontSize: 12,
    color: "#999",
    marginTop: 4,
    marginBottom: 16,
  },
  label: {
    fontSize: 14,
    fontWeight: "600",
    color: "#333",
    marginBottom: 4,
    marginTop: 12,
  },
  input: {
    backgroundColor: "#fff",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#ddd",
    padding: 12,
    fontSize: 16,
    color: "#1a1a1a",
  },
  mealSelector: {
    flexDirection: "row",
    gap: 8,
    marginTop: 4,
  },
  mealOption: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: "#e9ecef",
  },
  mealOptionSelected: {
    backgroundColor: "#007AFF",
  },
  mealOptionText: {
    fontSize: 14,
    color: "#666",
    fontWeight: "500",
  },
  mealOptionTextSelected: {
    color: "#fff",
  },
  macroRow: {
    flexDirection: "row",
    gap: 12,
  },
  macroField: {
    flex: 1,
  },
  saveButton: {
    backgroundColor: "#007AFF",
    borderRadius: 12,
    padding: 16,
    alignItems: "center",
    marginTop: 32,
  },
  saveButtonText: {
    color: "#fff",
    fontSize: 18,
    fontWeight: "700",
  },
});
