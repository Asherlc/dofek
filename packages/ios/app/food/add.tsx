import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { BarcodeScanner } from "../../components/BarcodeScanner";

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:3000/api/trpc";
import { lookupBarcode, searchFoods } from "../../lib/food-database";
import { trpc } from "../../lib/trpc";

type MealType = "breakfast" | "lunch" | "dinner" | "snack" | "other";

const MEAL_OPTIONS: { key: MealType; label: string }[] = [
  { key: "breakfast", label: "Breakfast" },
  { key: "lunch", label: "Lunch" },
  { key: "dinner", label: "Dinner" },
  { key: "snack", label: "Snack" },
  { key: "other", label: "Other" },
];

function todayString(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function autoMealType(): MealType {
  const hour = new Date().getHours();
  if (hour < 10) return "breakfast";
  if (hour < 14) return "lunch";
  if (hour < 17) return "snack";
  return "dinner";
}

// Merged search result from our DB + Open Food Facts
interface SearchResult {
  source: "history" | "openfoodfacts";
  name: string;
  brand: string | null;
  calories: number | null;
  proteinG: number | null;
  carbsG: number | null;
  fatG: number | null;
  servingDescription: string | null;
  barcode: string | null;
}

export default function AddFoodScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ meal?: string; date?: string }>();
  const date = params.date ?? todayString();

  // ── Search state ──
  const [searchQuery, setSearchQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [showScanner, setShowScanner] = useState(false);
  const [scanningBarcode, setScanningBarcode] = useState(false);
  const searchTimeout = useRef<ReturnType<typeof setTimeout>>();

  // ── Form state (shown after selecting a result or for manual entry) ──
  const [showForm, setShowForm] = useState(false);
  const [foodName, setFoodName] = useState("");
  const [selectedMeal, setSelectedMeal] = useState<MealType>(
    (params.meal as MealType) || autoMealType(),
  );
  const [calories, setCalories] = useState("");
  const [proteinGrams, setProteinGrams] = useState("");
  const [carbsGrams, setCarbsGrams] = useState("");
  const [fatGrams, setFatGrams] = useState("");
  const [servingDescription, setServingDescription] = useState("");

  // ── Recent foods (loaded once on mount) ──
  const [recentFoods, setRecentFoods] = useState<SearchResult[]>([]);
  const recentLoaded = useRef(false);

  useEffect(() => {
    if (recentLoaded.current) return;
    recentLoaded.current = true;

    // Fetch yesterday + today's entries as "recent" foods
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yStr = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, "0")}-${String(yesterday.getDate()).padStart(2, "0")}`;

    Promise.all([
      fetch(`${API_URL}/food.byDate?batch=1`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ "0": { date } }),
      }).then((r) => r.json()).catch(() => null),
      fetch(`${API_URL}/food.byDate?batch=1`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ "0": { date: yStr } }),
      }).then((r) => r.json()).catch(() => null),
    ]).then(([todayData, yesterdayData]) => {
      const todayEntries: Record<string, unknown>[] = todayData?.[0]?.result?.data ?? [];
      const yesterdayEntries: Record<string, unknown>[] = yesterdayData?.[0]?.result?.data ?? [];

      // Deduplicate by food name, today's entries first
      const seen = new Set<string>();
      const results: SearchResult[] = [];
      for (const r of [...todayEntries, ...yesterdayEntries]) {
        const name = r.food_name as string;
        if (seen.has(name)) continue;
        seen.add(name);
        results.push({
          source: "history",
          name,
          brand: null,
          calories: r.calories as number | null,
          proteinG: r.protein_g as number | null,
          carbsG: r.carbs_g as number | null,
          fatG: r.fat_g as number | null,
          servingDescription: r.food_description as string | null,
          barcode: null,
        });
      }
      setRecentFoods(results);
    });
  }, [date]);

  const utils = trpc.useUtils();
  const createMutation = trpc.food.create.useMutation({
    onSuccess: () => {
      utils.food.byDate.invalidate({ date });
      router.back();
    },
    onError: (error) => {
      Alert.alert("Error", error.message);
    },
  });

  // ── Search logic ──
  const performSearch = useCallback(async (query: string) => {
    if (query.length < 2) {
      setSearchResults([]);
      setSearching(false);
      return;
    }

    setSearching(true);

    // Search our history and Open Food Facts in parallel
    const [historyResults, offResults] = await Promise.all([
      // Our DB search via tRPC - we call it directly
      fetch(`${API_URL}/food.search?batch=1`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ "0": { query, limit: 5 } }),
      })
        .then((r) => r.json())
        .then((data) => {
          const results = data?.[0]?.result?.data ?? [];
          return results.map((r: Record<string, unknown>): SearchResult => ({
            source: "history" as const,
            name: r.food_name as string,
            brand: null,
            calories: r.calories as number | null,
            proteinG: r.protein_g as number | null,
            carbsG: r.carbs_g as number | null,
            fatG: r.fat_g as number | null,
            servingDescription: r.food_description as string | null,
            barcode: null,
          }));
        })
        .catch(() => [] as SearchResult[]),
      searchFoods(query, 10),
    ]);

    const offMapped: SearchResult[] = offResults.map((r) => ({
      source: "openfoodfacts",
      name: r.brand ? `${r.name} (${r.brand})` : r.name,
      brand: r.brand,
      calories: r.calories,
      proteinG: r.proteinG,
      carbsG: r.carbsG,
      fatG: r.fatG,
      servingDescription: r.servingSize,
      barcode: r.barcode,
    }));

    // History first, then Open Food Facts
    setSearchResults([...historyResults, ...offMapped]);
    setSearching(false);
  }, []);

  // Debounced search
  useEffect(() => {
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    if (searchQuery.length < 2) {
      setSearchResults([]);
      return;
    }
    searchTimeout.current = setTimeout(() => performSearch(searchQuery), 300);
    return () => {
      if (searchTimeout.current) clearTimeout(searchTimeout.current);
    };
  }, [searchQuery, performSearch]);

  // ── Barcode scan ──
  async function handleBarcodeScan(barcodeValue: string) {
    setShowScanner(false);
    setScanningBarcode(true);

    const result = await lookupBarcode(barcodeValue);
    setScanningBarcode(false);

    if (result) {
      fillForm({
        source: "openfoodfacts",
        name: result.brand ? `${result.name} (${result.brand})` : result.name,
        brand: result.brand,
        calories: result.calories,
        proteinG: result.proteinG,
        carbsG: result.carbsG,
        fatG: result.fatG,
        servingDescription: result.servingSize,
        barcode: barcodeValue,
      });
    } else {
      Alert.alert("Not Found", "Barcode not found in database. Enter details manually.", [
        {
          text: "OK",
          onPress: () => {
            setShowForm(true);
          },
        },
      ]);
    }
  }

  // ── Select result → fill form ──
  function fillForm(result: SearchResult) {
    setFoodName(result.name);
    setCalories(result.calories != null ? String(result.calories) : "");
    setProteinGrams(result.proteinG != null ? String(result.proteinG) : "");
    setCarbsGrams(result.carbsG != null ? String(result.carbsG) : "");
    setFatGrams(result.fatG != null ? String(result.fatG) : "");
    setServingDescription(result.servingDescription ?? "");
    setShowForm(true);
  }

  // ── Quick log: tap a result with complete data to save immediately ──
  function handleSelectResult(result: SearchResult) {
    if (result.calories != null && result.calories > 0) {
      // Has enough data for quick log — show pre-filled form for one-tap save
      fillForm(result);
    } else {
      fillForm(result);
    }
  }

  // ── Save ──
  function handleSave() {
    const parsedCalories = Number.parseInt(calories, 10);
    if (!foodName.trim()) {
      Alert.alert("Missing field", "Food name is required.");
      return;
    }
    if (Number.isNaN(parsedCalories)) {
      Alert.alert("Missing field", "Calories is required.");
      return;
    }

    createMutation.mutate({
      date,
      foodName: foodName.trim(),
      meal: selectedMeal,
      calories: parsedCalories,
      proteinG: proteinGrams ? Number.parseFloat(proteinGrams) : null,
      carbsG: carbsGrams ? Number.parseFloat(carbsGrams) : null,
      fatG: fatGrams ? Number.parseFloat(fatGrams) : null,
      foodDescription: servingDescription.trim() || null,
    });
  }

  // ── Barcode scanner overlay ──
  if (showScanner) {
    return <BarcodeScanner onScanned={handleBarcodeScan} onClose={() => setShowScanner(false)} />;
  }

  // ── Pre-filled form (after selecting a search result) ──
  if (showForm) {
    return (
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <ScrollView style={styles.scrollView} contentContainerStyle={styles.content}>
          {/* Food name (editable) */}
          <Text style={styles.label}>Name</Text>
          <TextInput
            style={styles.input}
            value={foodName}
            onChangeText={setFoodName}
            placeholder="Food name"
            placeholderTextColor="#999"
          />

          {/* Meal selector */}
          <Text style={styles.label}>Meal</Text>
          <View style={styles.mealSelector}>
            {MEAL_OPTIONS.map(({ key, label }) => (
              <TouchableOpacity
                key={key}
                style={[styles.mealChip, selectedMeal === key && styles.mealChipSelected]}
                onPress={() => setSelectedMeal(key)}
                activeOpacity={0.7}
              >
                <Text style={[styles.mealChipText, selectedMeal === key && styles.mealChipTextSelected]}>
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
            onChangeText={setCalories}
            placeholder="0"
            placeholderTextColor="#999"
            keyboardType="numeric"
          />

          {/* Serving description */}
          {servingDescription ? (
            <Text style={styles.servingHint}>{servingDescription}</Text>
          ) : null}

          {/* Macros — compact row */}
          <View style={styles.macroRow}>
            <View style={styles.macroField}>
              <Text style={styles.macroLabel}>Protein</Text>
              <TextInput
                style={styles.macroInput}
                value={proteinGrams}
                onChangeText={setProteinGrams}
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
                onChangeText={setCarbsGrams}
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
                onChangeText={setFatGrams}
                placeholder="g"
                placeholderTextColor="#bbb"
                keyboardType="numeric"
              />
            </View>
          </View>

          {/* Action buttons */}
          <View style={styles.formButtons}>
            <TouchableOpacity
              style={styles.backButton}
              onPress={() => setShowForm(false)}
              activeOpacity={0.7}
            >
              <Text style={styles.backButtonText}>Back</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.saveButton, createMutation.isPending && styles.saveButtonDisabled]}
              onPress={handleSave}
              activeOpacity={0.8}
              disabled={createMutation.isPending}
            >
              <Text style={styles.saveButtonText}>
                {createMutation.isPending ? "Saving..." : "Log Food"}
              </Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    );
  }

  // ── Search screen (default) ──
  const displayResults = searchQuery.length >= 2 ? searchResults : recentFoods;

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      {/* Search bar + barcode button */}
      <View style={styles.searchBar}>
        <TextInput
          style={styles.searchInput}
          value={searchQuery}
          onChangeText={setSearchQuery}
          placeholder="Search foods..."
          placeholderTextColor="#999"
          autoFocus
          returnKeyType="search"
        />
        <TouchableOpacity
          style={styles.barcodeButton}
          onPress={() => setShowScanner(true)}
          activeOpacity={0.7}
        >
          <Text style={styles.barcodeButtonText}>Scan</Text>
        </TouchableOpacity>
      </View>

      {scanningBarcode && (
        <View style={styles.scanningOverlay}>
          <ActivityIndicator size="large" color="#007AFF" />
          <Text style={styles.scanningText}>Looking up barcode...</Text>
        </View>
      )}

      <ScrollView style={styles.scrollView} keyboardShouldPersistTaps="handled">
        {/* Section header */}
        <Text style={styles.sectionHeader}>
          {searchQuery.length >= 2 ? "Results" : "Recent Foods"}
        </Text>

        {searching && (
          <View style={styles.loadingRow}>
            <ActivityIndicator size="small" color="#007AFF" />
          </View>
        )}

        {displayResults.map((result, index) => (
          <TouchableOpacity
            key={`${result.source}-${result.name}-${index}`}
            style={styles.resultRow}
            onPress={() => handleSelectResult(result)}
            activeOpacity={0.6}
          >
            <View style={styles.resultLeft}>
              <Text style={styles.resultName} numberOfLines={1}>
                {result.name}
              </Text>
              {result.servingDescription && (
                <Text style={styles.resultServing} numberOfLines={1}>
                  {result.servingDescription}
                </Text>
              )}
            </View>
            <View style={styles.resultRight}>
              {result.calories != null && (
                <Text style={styles.resultCalories}>{result.calories} cal</Text>
              )}
              <Text style={styles.resultSource}>
                {result.source === "history" ? "History" : "OFF"}
              </Text>
            </View>
          </TouchableOpacity>
        ))}

        {!searching && displayResults.length === 0 && searchQuery.length >= 2 && (
          <Text style={styles.emptyText}>No results found</Text>
        )}

        {/* Manual entry option */}
        <TouchableOpacity
          style={styles.manualEntry}
          onPress={() => {
            if (searchQuery.trim()) setFoodName(searchQuery.trim());
            setShowForm(true);
          }}
          activeOpacity={0.7}
        >
          <Text style={styles.manualEntryText}>
            {searchQuery.trim()
              ? `Add "${searchQuery.trim()}" manually`
              : "Enter food manually"}
          </Text>
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#000",
  },
  scrollView: {
    flex: 1,
  },
  content: {
    padding: 16,
    paddingBottom: 40,
  },

  // ── Search bar ──
  searchBar: {
    flexDirection: "row",
    padding: 12,
    paddingTop: 8,
    gap: 8,
    backgroundColor: "#1c1c1e",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#2a2a2e",
  },
  searchInput: {
    flex: 1,
    backgroundColor: "#2a2a2e",
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 16,
    color: "#fff",
  },
  barcodeButton: {
    backgroundColor: "#007AFF",
    borderRadius: 10,
    paddingHorizontal: 16,
    justifyContent: "center",
  },
  barcodeButtonText: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "600",
  },

  // ── Search results ──
  sectionHeader: {
    fontSize: 13,
    fontWeight: "600",
    color: "#8e8e93",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 6,
  },
  loadingRow: {
    paddingVertical: 16,
    alignItems: "center",
  },
  resultRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 12,
    paddingHorizontal: 16,
    backgroundColor: "#1c1c1e",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#2a2a2e",
  },
  resultLeft: {
    flex: 1,
    marginRight: 12,
  },
  resultName: {
    fontSize: 16,
    color: "#fff",
    fontWeight: "500",
  },
  resultServing: {
    fontSize: 13,
    color: "#636366",
    marginTop: 2,
  },
  resultRight: {
    alignItems: "flex-end",
  },
  resultCalories: {
    fontSize: 15,
    fontWeight: "600",
    color: "#8e8e93",
  },
  resultSource: {
    fontSize: 11,
    color: "#636366",
    marginTop: 2,
  },
  emptyText: {
    textAlign: "center",
    color: "#636366",
    paddingVertical: 24,
  },
  manualEntry: {
    paddingVertical: 16,
    paddingHorizontal: 16,
    alignItems: "center",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#2a2a2e",
    marginTop: 8,
  },
  manualEntryText: {
    fontSize: 15,
    color: "#007AFF",
    fontWeight: "500",
  },

  // ── Scanning overlay ──
  scanningOverlay: {
    paddingVertical: 24,
    alignItems: "center",
    gap: 8,
  },
  scanningText: {
    fontSize: 14,
    color: "#8e8e93",
  },

  // ── Form (after selection) ──
  label: {
    fontSize: 14,
    fontWeight: "600",
    color: "#8e8e93",
    marginBottom: 4,
    marginTop: 14,
  },
  input: {
    backgroundColor: "#1c1c1e",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#2a2a2e",
    padding: 12,
    fontSize: 16,
    color: "#fff",
  },
  calorieInput: {
    fontSize: 24,
    fontWeight: "700",
    textAlign: "center",
    paddingVertical: 16,
  },
  servingHint: {
    fontSize: 13,
    color: "#636366",
    marginTop: 4,
    textAlign: "center",
  },
  mealSelector: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginTop: 4,
  },
  mealChip: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 18,
    backgroundColor: "#2a2a2e",
  },
  mealChipSelected: {
    backgroundColor: "#007AFF",
  },
  mealChipText: {
    fontSize: 14,
    color: "#8e8e93",
    fontWeight: "500",
  },
  mealChipTextSelected: {
    color: "#fff",
  },
  macroRow: {
    flexDirection: "row",
    gap: 10,
    marginTop: 16,
  },
  macroField: {
    flex: 1,
    alignItems: "center",
  },
  macroLabel: {
    fontSize: 12,
    fontWeight: "600",
    color: "#636366",
    marginBottom: 4,
  },
  macroInput: {
    backgroundColor: "#1c1c1e",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#2a2a2e",
    padding: 10,
    fontSize: 16,
    color: "#fff",
    textAlign: "center",
    width: "100%",
  },
  formButtons: {
    flexDirection: "row",
    gap: 12,
    marginTop: 28,
  },
  backButton: {
    flex: 1,
    borderRadius: 12,
    padding: 16,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#2a2a2e",
  },
  backButtonText: {
    color: "#8e8e93",
    fontSize: 16,
    fontWeight: "600",
  },
  saveButton: {
    flex: 2,
    backgroundColor: "#007AFF",
    borderRadius: 12,
    padding: 16,
    alignItems: "center",
  },
  saveButtonDisabled: {
    opacity: 0.5,
  },
  saveButtonText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "700",
  },
});
