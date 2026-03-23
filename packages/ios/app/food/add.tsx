import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  useWindowDimensions,
} from "react-native";
import { BarcodeScanner } from "../../components/BarcodeScanner";
import { useAuth } from "../../lib/auth-context";
import { colors } from "../../theme";

import { OpenFoodFactsClient } from "../../lib/food-database";
import { MEAL_OPTIONS, type MealType, autoMealType } from "@dofek/nutrition/meal";
import { formatDateYmd } from "@dofek/format/format";
import { SERVER_URL, getTrpcUrl } from "../../lib/server";
import { trpc } from "../../lib/trpc";

type LoggerTab = "search" | "scan" | "quickadd";

const TABS: { key: LoggerTab; label: string }[] = [
  { key: "search", label: "Search" },
  { key: "scan", label: "Scan" },
  { key: "quickadd", label: "Quick Add" },
];

/** Parse a numeric string, returning null for empty/invalid input instead of NaN. */
function safeParseFloat(value: string): number | null {
  if (!value) return null;
  const n = Number.parseFloat(value);
  return Number.isNaN(n) ? null : n;
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
  const date = params.date ?? formatDateYmd();
  const { sessionToken } = useAuth();
  const apiUrl = getTrpcUrl(SERVER_URL);
  const authHeaders = useMemo<Record<string, string>>(
    () =>
      sessionToken
        ? { Authorization: `Bearer ${sessionToken}` }
        : ({} as Record<string, string>),
    [sessionToken],
  );

  // ── Tab state ──
  const [activeTab, setActiveTab] = useState<LoggerTab>("search");

  // ── Search state ──
  const [searchQuery, setSearchQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [scanningBarcode, setScanningBarcode] = useState(false);
  const searchTimeout = useRef<ReturnType<typeof setTimeout>>();

  // ── Form state (shown after selecting a result or manual entry) ──
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
  const { width } = useWindowDimensions();
  const isWide = width >= 600;
  const deviceLocale = useMemo(
    () => Intl.DateTimeFormat().resolvedOptions().locale ?? "en-US",
    [],
  );
  const foodClient = useMemo(() => new OpenFoodFactsClient(deviceLocale), [deviceLocale]);

  useEffect(() => {
    if (recentLoaded.current) return;
    recentLoaded.current = true;

    // Fetch yesterday + today's entries as "recent" foods
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yStr = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, "0")}-${String(yesterday.getDate()).padStart(2, "0")}`;

    Promise.all([
      fetch(`${apiUrl}/food.byDate?batch=1`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({ "0": { date } }),
      }).then((r) => r.json()).catch(() => null),
      fetch(`${apiUrl}/food.byDate?batch=1`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
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

  const quickAddMutation = trpc.food.quickAdd.useMutation({
    onSuccess: () => {
      utils.food.byDate.invalidate({ date });
      router.back();
    },
    onError: (error) => {
      Alert.alert("Error", error.message);
    },
  });

  // ── Open Food Facts on-demand search state ──
  const openFoodFactsRequestCounterRef = useRef(0);
  const [openFoodFactsResults, setOpenFoodFactsResults] = useState<SearchResult[]>([]);
  const [searchingOpenFoodFacts, setSearchingOpenFoodFacts] = useState(false);

  // ── Search logic (history only for fast typeahead) ──
  const performSearch = useCallback(async (query: string) => {
    if (query.length < 2) {
      setSearchResults([]);
      setSearching(false);
      return;
    }

    setSearching(true);
    // Clear previous Open Food Facts results when query changes
    setOpenFoodFactsResults([]);
    setSearchingOpenFoodFacts(false);
    openFoodFactsRequestCounterRef.current += 1;

    const historyResults = await fetch(`${apiUrl}/food.search?batch=1`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
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
      .catch(() => [] as SearchResult[]);

    setSearchResults(historyResults);
    setSearching(false);
  }, [apiUrl, authHeaders]);

  // ── On-demand Open Food Facts search ──
  const performOpenFoodFactsSearch = useCallback(async () => {
    if (searchQuery.length < 2) return;

    const requestId = openFoodFactsRequestCounterRef.current + 1;
    openFoodFactsRequestCounterRef.current = requestId;
    setSearchingOpenFoodFacts(true);
    try {
      const results = await foodClient.searchFoods(searchQuery, 10);
      if (openFoodFactsRequestCounterRef.current !== requestId) return;
      const mapped: SearchResult[] = results.map((r) => ({
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
      setOpenFoodFactsResults(mapped);
    } catch {
      if (openFoodFactsRequestCounterRef.current !== requestId) return;
      setOpenFoodFactsResults([]);
    } finally {
      if (openFoodFactsRequestCounterRef.current === requestId) {
        setSearchingOpenFoodFacts(false);
      }
    }
  }, [searchQuery, foodClient]);

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
    setActiveTab("search");
    setScanningBarcode(true);

    const result = await foodClient.lookupBarcode(barcodeValue);
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

  function handleSelectResult(result: SearchResult) {
    fillForm(result);
  }

  // ── Save (from form after search/scan selection) ──
  function handleSave() {
    const parsedCalories = Number.parseInt(calories, 10);
    if (!foodName.trim()) {
      Alert.alert("Missing field", "Food name is required.");
      return;
    }
    if (Number.isNaN(parsedCalories) || parsedCalories <= 0) {
      Alert.alert("Missing field", "Enter a calorie amount.");
      return;
    }

    createMutation.mutate({
      date,
      foodName: foodName.trim(),
      meal: selectedMeal,
      calories: parsedCalories,
      proteinG: safeParseFloat(proteinGrams),
      carbsG: safeParseFloat(carbsGrams),
      fatG: safeParseFloat(fatGrams),
      foodDescription: servingDescription.trim() || null,
    });
  }

  // ── Save (from quick-add tab) ──
  function handleQuickAddSave() {
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
      proteinG: safeParseFloat(proteinGrams),
      carbsG: safeParseFloat(carbsGrams),
      fatG: safeParseFloat(fatGrams),
    });
  }

  // ── Barcode scanner overlay (full-screen) ──
  if (activeTab === "scan" && !showForm) {
    return (
      <BarcodeScanner
        onScanned={handleBarcodeScan}
        onClose={() => setActiveTab("search")}
      />
    );
  }

  // ── Detail form (after selecting a search result or scan result) ──
  if (showForm) {
    const isSaving = createMutation.isPending || quickAddMutation.isPending;
    return (
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <ScrollView style={styles.scrollView} contentContainerStyle={[styles.formContent, isWide && styles.contentWide]}>
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
            {MEAL_OPTIONS.map(({ value, label }) => (
              <TouchableOpacity
                key={value}
                style={[styles.mealChip, selectedMeal === value && styles.mealChipSelected]}
                onPress={() => setSelectedMeal(value)}
                activeOpacity={0.7}
              >
                <Text style={[styles.mealChipText, selectedMeal === value && styles.mealChipTextSelected]}>
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
              style={[styles.saveButton, { flex: 2 }, isSaving && styles.saveButtonDisabled]}
              onPress={handleSave}
              activeOpacity={0.8}
              disabled={isSaving}
            >
              <Text style={styles.saveButtonText}>
                {isSaving ? "Saving..." : "Log Food"}
              </Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    );
  }

  // ── Main screen with tab ribbon ──
  const displayResults = searchQuery.length >= 2 ? searchResults : recentFoods;

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      {/* Tab ribbon */}
      <View style={styles.ribbon}>
        {TABS.map(({ key, label }) => (
          <TouchableOpacity
            key={key}
            style={[styles.ribbonTab, activeTab === key && styles.ribbonTabActive]}
            onPress={() => setActiveTab(key)}
            activeOpacity={0.7}
          >
            <Text style={[styles.ribbonTabText, activeTab === key && styles.ribbonTabTextActive]}>
              {label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Search tab */}
      {activeTab === "search" && (
        <>
          {/* Search bar */}
          <View style={styles.searchBar}>
            <TextInput
              style={styles.searchInput}
              value={searchQuery}
              onChangeText={setSearchQuery}
              placeholder="Search foods..."
              placeholderTextColor="#999"
              autoFocus={!scanningBarcode}
              returnKeyType="search"
            />
          </View>

          {scanningBarcode && (
            <View style={styles.scanningOverlay}>
              <ActivityIndicator size="large" color={colors.accent} />
              <Text style={styles.scanningText}>Looking up barcode...</Text>
            </View>
          )}

          <ScrollView
            style={styles.scrollView}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={styles.resultsContent}
          >
            {/* Section header */}
            <Text style={styles.sectionHeader}>
              {searchQuery.length >= 2 ? "Results" : "Recent Foods"}
            </Text>

            {searching && (
              <View style={styles.loadingRow}>
                <ActivityIndicator size="small" color={colors.accent} />
              </View>
            )}

            {displayResults.map((result, index) => {
              const macroTags = [
                result.proteinG != null ? `Protein ${result.proteinG}g` : null,
                result.carbsG != null ? `Carbs ${result.carbsG}g` : null,
                result.fatG != null ? `Fat ${result.fatG}g` : null,
              ].filter((tag): tag is string => tag !== null);

              return (
                <TouchableOpacity
                  key={`${result.source}-${result.name}-${index}`}
                  style={styles.resultCard}
                  onPress={() => handleSelectResult(result)}
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
                      {result.source === "history" ? "History" : "Open Food Facts"}
                    </Text>
                  </View>
                </TouchableOpacity>
              );
            })}

            {!searching && displayResults.length === 0 && searchQuery.length >= 2 && (
              <Text style={styles.emptyText}>No results found</Text>
            )}

            {!searching && displayResults.length === 0 && searchQuery.length < 2 && (
              <Text style={styles.emptyText}>No recent foods. Search or scan to get started.</Text>
            )}

            {/* Search Food Database button (Open Food Facts, on-demand) */}
            {searchQuery.length >= 2 && (
              <TouchableOpacity
                style={styles.searchDatabaseButton}
                onPress={performOpenFoodFactsSearch}
                activeOpacity={0.7}
                disabled={searchingOpenFoodFacts}
              >
                {searchingOpenFoodFacts ? (
                  <ActivityIndicator size="small" color={colors.text} />
                ) : (
                  <Text style={styles.searchDatabaseButtonText}>Search Food Database</Text>
                )}
              </TouchableOpacity>
            )}

            {/* Open Food Facts results (shown after explicit search) */}
            {openFoodFactsResults.length > 0 && (
              <>
                <Text style={styles.sectionHeader}>Food Database</Text>
                {openFoodFactsResults.map((result, index) => {
                  const macroTags = [
                    result.proteinG != null ? `Protein ${result.proteinG}g` : null,
                    result.carbsG != null ? `Carbs ${result.carbsG}g` : null,
                    result.fatG != null ? `Fat ${result.fatG}g` : null,
                  ].filter((tag): tag is string => tag !== null);

                  return (
                    <TouchableOpacity
                      key={`off-${result.name}-${index}`}
                      style={styles.resultCard}
                      onPress={() => handleSelectResult(result)}
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
                        <Text style={styles.resultSource}>Open Food Facts</Text>
                      </View>
                    </TouchableOpacity>
                  );
                })}
              </>
            )}

            {/* Manual entry option */}
            <TouchableOpacity
              style={styles.manualEntry}
              onPress={() => {
                setFoodName(searchQuery.trim());
                setCalories("");
                setProteinGrams("");
                setCarbsGrams("");
                setFatGrams("");
                setServingDescription("");
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
        </>
      )}

      {/* Quick Add tab */}
      {activeTab === "quickadd" && (
        <ScrollView
          style={styles.scrollView}
          contentContainerStyle={[styles.formContent, isWide && styles.contentWide]}
          keyboardShouldPersistTaps="handled"
        >
          {/* Food name */}
          <TextInput
            style={styles.quickAddNameInput}
            value={foodName}
            onChangeText={setFoodName}
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
                onPress={() => setSelectedMeal(value)}
                activeOpacity={0.7}
              >
                <Text style={[styles.mealChipText, selectedMeal === value && styles.mealChipTextSelected]}>
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
              onChangeText={setCalories}
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
                onChangeText={setProteinGrams}
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
                onChangeText={setCarbsGrams}
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
                onChangeText={setFatGrams}
                placeholder="g"
                placeholderTextColor={colors.textTertiary}
                keyboardType="numeric"
              />
            </View>
          </View>

          {/* Log button */}
          <TouchableOpacity
            style={[styles.saveButton, { marginTop: 16 }, quickAddMutation.isPending && styles.saveButtonDisabled]}
            onPress={handleQuickAddSave}
            activeOpacity={0.8}
            disabled={quickAddMutation.isPending}
          >
            <Text style={styles.saveButtonText}>
              {quickAddMutation.isPending ? "Saving..." : "Log"}
            </Text>
          </TouchableOpacity>
        </ScrollView>
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  scrollView: {
    flex: 1,
  },
  resultsContent: {
    paddingBottom: 24,
  },
  formContent: {
    padding: 16,
    paddingBottom: 40,
  },
  contentWide: {
    maxWidth: 600,
    alignSelf: "center",
    width: "100%",
  },

  // ── Tab ribbon ──
  ribbon: {
    flexDirection: "row",
    backgroundColor: colors.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.surfaceSecondary,
    paddingHorizontal: 8,
  },
  ribbonTab: {
    flex: 1,
    paddingVertical: 12,
    alignItems: "center",
    borderBottomWidth: 2,
    borderBottomColor: "transparent",
  },
  ribbonTabActive: {
    borderBottomColor: colors.accent,
  },
  ribbonTabText: {
    fontSize: 15,
    fontWeight: "600",
    color: colors.textSecondary,
  },
  ribbonTabTextActive: {
    color: colors.accent,
  },

  // ── Search bar ──
  searchBar: {
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 10,
    backgroundColor: colors.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.surfaceSecondary,
  },
  searchInput: {
    backgroundColor: colors.background,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    fontSize: 16,
    color: colors.text,
    borderWidth: 1,
    borderColor: colors.surfaceSecondary,
  },

  // ── Search results ──
  sectionHeader: {
    fontSize: 12,
    fontWeight: "600",
    color: colors.textSecondary,
    textTransform: "uppercase",
    letterSpacing: 0.7,
    paddingHorizontal: 14,
    paddingTop: 14,
    paddingBottom: 10,
  },
  loadingRow: {
    paddingVertical: 20,
    alignItems: "center",
  },
  resultCard: {
    marginHorizontal: 14,
    marginBottom: 10,
    padding: 14,
    backgroundColor: colors.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.surfaceSecondary,
  },
  resultHeaderRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
  },
  resultName: {
    flex: 1,
    fontSize: 16,
    lineHeight: 22,
    color: colors.text,
    fontWeight: "600",
  },
  resultCaloriesBadge: {
    backgroundColor: colors.background,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.surfaceSecondary,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  resultCaloriesText: {
    fontSize: 12,
    fontWeight: "700",
    color: colors.text,
  },
  resultServing: {
    fontSize: 13,
    color: colors.textTertiary,
    marginTop: 6,
    lineHeight: 18,
  },
  resultMetaRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 12,
    gap: 10,
  },
  resultMacroTags: {
    flex: 1,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  resultMacroTag: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: colors.background,
  },
  resultMacroTagText: {
    fontSize: 11,
    color: colors.textSecondary,
    fontWeight: "600",
  },
  resultSource: {
    fontSize: 11,
    color: colors.textTertiary,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  emptyText: {
    textAlign: "center",
    color: colors.textTertiary,
    paddingVertical: 28,
    paddingHorizontal: 18,
  },
  manualEntry: {
    marginHorizontal: 14,
    marginTop: 6,
    paddingVertical: 14,
    paddingHorizontal: 14,
    alignItems: "center",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.accent,
    backgroundColor: colors.surface,
  },
  manualEntryText: {
    fontSize: 15,
    color: colors.accent,
    fontWeight: "500",
  },
  searchDatabaseButton: {
    marginHorizontal: 14,
    marginTop: 10,
    paddingVertical: 14,
    paddingHorizontal: 14,
    alignItems: "center",
    borderRadius: 12,
    backgroundColor: colors.accent,
  },
  searchDatabaseButtonText: {
    fontSize: 15,
    color: colors.text,
    fontWeight: "600",
  },

  // ── Scanning overlay ──
  scanningOverlay: {
    paddingVertical: 24,
    alignItems: "center",
    gap: 8,
  },
  scanningText: {
    fontSize: 14,
    color: colors.textSecondary,
  },

  // ── Form (after selection) ──
  label: {
    fontSize: 14,
    fontWeight: "600",
    color: colors.textSecondary,
    marginBottom: 4,
    marginTop: 14,
  },
  input: {
    backgroundColor: colors.surface,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.surfaceSecondary,
    padding: 12,
    fontSize: 16,
    color: colors.text,
  },
  calorieInput: {
    fontSize: 24,
    fontWeight: "700",
    textAlign: "center",
    paddingVertical: 16,
  },
  servingHint: {
    fontSize: 13,
    color: colors.textTertiary,
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
  macroRow: {
    flexDirection: "row",
    gap: 10,
    marginTop: 16,
  },
  macroField: {
    flex: 1,
    alignItems: "center",
    gap: 4,
  },
  macroLabel: {
    fontSize: 12,
    fontWeight: "600",
    color: colors.textSecondary,
  },
  macroInput: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: 8,
    padding: 10,
    fontSize: 16,
    color: colors.text,
    textAlign: "center",
    width: "100%",
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
    borderColor: colors.surfaceSecondary,
  },
  backButtonText: {
    color: colors.textSecondary,
    fontSize: 16,
    fontWeight: "600",
  },
  saveButton: {
    backgroundColor: colors.accent,
    borderRadius: 12,
    padding: 16,
    alignItems: "center",
  },
  saveButtonDisabled: {
    opacity: 0.5,
  },
  saveButtonText: {
    color: colors.text,
    fontSize: 17,
    fontWeight: "700",
  },

  // ── Quick-add tab ──
  quickAddNameInput: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 16,
    color: colors.text,
    marginBottom: 12,
  },
  quickAddCalorieSection: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "center",
    gap: 4,
    marginTop: 16,
    marginBottom: 8,
  },
  quickAddCalorieInput: {
    fontSize: 48,
    fontWeight: "700",
    color: colors.text,
    textAlign: "center",
    minWidth: 120,
    fontVariant: ["tabular-nums"],
  },
  quickAddCalorieUnit: {
    fontSize: 20,
    color: colors.textSecondary,
    fontWeight: "500",
  },
});
