import { formatDateYmd } from "@dofek/format/format";
import { autoMealType, MEAL_OPTIONS, type MealType } from "@dofek/nutrition/meal";
import { OpenFoodFactsClient } from "@dofek/nutrition/open-food-facts";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from "react-native";
import { BarcodeScanner } from "../../components/BarcodeScanner";
import { useAuth } from "../../lib/auth-context";
import { getTrpcUrl, SERVER_URL } from "../../lib/server";
import { captureException } from "../../lib/telemetry";
import { trpc } from "../../lib/trpc";
import { colors } from "../../theme";
import { styles } from "./add-styles.ts";
import {
  FoodEntrySchema,
  type LoggerTab,
  type SearchResult,
  safeParseFloat,
  TABS,
} from "./add-types.ts";
import { FoodDetailForm } from "./FoodDetailForm.tsx";
import { FoodResultCard } from "./FoodResultCard.tsx";
import { QuickAddTab } from "./QuickAddTab.tsx";

export default function AddFoodScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ meal?: string; date?: string }>();
  const date = params.date ?? formatDateYmd();
  const { sessionToken } = useAuth();
  const apiUrl = getTrpcUrl(SERVER_URL);
  const authorizationHeader = useMemo(
    () => (sessionToken ? `Bearer ${sessionToken}` : null),
    [sessionToken],
  );

  // ── Tab state ──
  const [activeTab, setActiveTab] = useState<LoggerTab>("search");

  // ── Search state ──
  const [searchQuery, setSearchQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [scanningBarcode, setScanningBarcode] = useState(false);
  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Form state (shown after selecting a result or manual entry) ──
  const [showForm, setShowForm] = useState(false);
  const [foodName, setFoodName] = useState("");
  const [selectedMeal, setSelectedMeal] = useState<MealType>(() => {
    const paramMeal = params.meal;
    const matched = MEAL_OPTIONS.find((option) => option.value === paramMeal);
    return matched ? matched.value : autoMealType();
  });
  const [calories, setCalories] = useState("");
  const [proteinGrams, setProteinGrams] = useState("");
  const [carbsGrams, setCarbsGrams] = useState("");
  const [fatGrams, setFatGrams] = useState("");
  const [servingDescription, setServingDescription] = useState("");

  // ── Micronutrient data from selected food result (passed through to create mutation) ──
  const selectedFoodNutrients = useRef<Record<string, number>>({});

  // ── Recent foods (loaded once on mount) ──
  const [recentFoods, setRecentFoods] = useState<SearchResult[]>([]);
  const recentLoaded = useRef(false);
  const { width } = useWindowDimensions();
  const isWide = width >= 600;
  const deviceLocale = useMemo(() => Intl.DateTimeFormat().resolvedOptions().locale ?? "en-US", []);
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
        headers: {
          "Content-Type": "application/json",
          ...(authorizationHeader ? { Authorization: authorizationHeader } : {}),
        },
        body: JSON.stringify({ "0": { date } }),
      })
        .then((r) => r.json())
        .catch((error: unknown) => {
          captureException(error, { source: "food-add-recent-today" });
          return null;
        }),
      fetch(`${apiUrl}/food.byDate?batch=1`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(authorizationHeader ? { Authorization: authorizationHeader } : {}),
        },
        body: JSON.stringify({ "0": { date: yStr } }),
      })
        .then((r) => r.json())
        .catch((error: unknown) => {
          captureException(error, { source: "food-add-recent-yesterday" });
          return null;
        }),
    ]).then(([todayData, yesterdayData]) => {
      const todayRaw: unknown[] = todayData?.[0]?.result?.data ?? [];
      const yesterdayRaw: unknown[] = yesterdayData?.[0]?.result?.data ?? [];

      const todayEntries = todayRaw.flatMap((item) => {
        const parsed = FoodEntrySchema.safeParse(item);
        return parsed.success ? [parsed.data] : [];
      });
      const yesterdayEntries = yesterdayRaw.flatMap((item) => {
        const parsed = FoodEntrySchema.safeParse(item);
        return parsed.success ? [parsed.data] : [];
      });

      // Deduplicate by food name, today's entries first
      const seen = new Set<string>();
      const results: SearchResult[] = [];
      for (const entry of [...todayEntries, ...yesterdayEntries]) {
        if (seen.has(entry.food_name)) continue;
        seen.add(entry.food_name);
        results.push({
          source: "history",
          name: entry.food_name,
          brand: null,
          calories: entry.calories ?? null,
          proteinG: entry.protein_g ?? null,
          carbsG: entry.carbs_g ?? null,
          fatG: entry.fat_g ?? null,
          servingDescription: entry.food_description ?? null,
          barcode: null,
        });
      }
      setRecentFoods(results);
    });
  }, [date, apiUrl, authorizationHeader]);

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
  const performSearch = useCallback(
    async (query: string, signal?: AbortSignal) => {
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
        headers: {
          "Content-Type": "application/json",
          ...(authorizationHeader ? { Authorization: authorizationHeader } : {}),
        },
        body: JSON.stringify({ "0": { query, limit: 5 } }),
        signal,
      })
        .then((r) => r.json())
        .then((data) => {
          const rawResults: unknown[] = data?.[0]?.result?.data ?? [];
          return rawResults.flatMap((item): SearchResult[] => {
            const parsed = FoodEntrySchema.safeParse(item);
            if (!parsed.success) return [];
            return [
              {
                source: "history",
                name: parsed.data.food_name,
                brand: null,
                calories: parsed.data.calories ?? null,
                proteinG: parsed.data.protein_g ?? null,
                carbsG: parsed.data.carbs_g ?? null,
                fatG: parsed.data.fat_g ?? null,
                servingDescription: parsed.data.food_description ?? null,
                barcode: null,
              },
            ];
          });
        })
        .catch((error: unknown): SearchResult[] => {
          captureException(error, { source: "food-add-history-search" });
          return [];
        });

      setSearchResults(historyResults);
      setSearching(false);
    },
    [apiUrl, authorizationHeader],
  );

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
    } catch (error: unknown) {
      captureException(error, { source: "food-add-openfoodfacts-search" });
      if (openFoodFactsRequestCounterRef.current !== requestId) return;
      setOpenFoodFactsResults([]);
    } finally {
      if (openFoodFactsRequestCounterRef.current === requestId) {
        setSearchingOpenFoodFacts(false);
      }
    }
  }, [searchQuery, foodClient]);

  // Debounced search with abort support
  const searchAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    if (searchAbortRef.current) searchAbortRef.current.abort();

    if (searchQuery.length < 2) {
      setSearchResults([]);
      return;
    }

    const controller = new AbortController();
    searchAbortRef.current = controller;

    searchTimeout.current = setTimeout(() => performSearch(searchQuery, controller.signal), 300);
    return () => {
      if (searchTimeout.current) clearTimeout(searchTimeout.current);
      controller.abort();
    };
  }, [searchQuery, performSearch]);

  // ── Barcode scan ──
  async function handleBarcodeScan(barcodeValue: string) {
    setActiveTab("search");
    setScanningBarcode(true);

    let result: Awaited<ReturnType<typeof foodClient.lookupBarcode>>;
    try {
      result = await foodClient.lookupBarcode(barcodeValue);
    } catch (error: unknown) {
      captureException(error, { source: "food-add-barcode-lookup" });
      result = null;
    }
    setScanningBarcode(false);

    if (result) {
      selectedFoodNutrients.current = result.nutrients;
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
    selectedFoodNutrients.current = result.openFoodFactsData?.nutrients ?? {};
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
      nutrients: selectedFoodNutrients.current,
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
    return <BarcodeScanner onScanned={handleBarcodeScan} onClose={() => setActiveTab("search")} />;
  }

  // ── Detail form (after selecting a search result or scan result) ──
  if (showForm) {
    return (
      <FoodDetailForm
        foodName={foodName}
        onFoodNameChange={setFoodName}
        selectedMeal={selectedMeal}
        onMealChange={setSelectedMeal}
        calories={calories}
        onCaloriesChange={setCalories}
        proteinGrams={proteinGrams}
        onProteinChange={setProteinGrams}
        carbsGrams={carbsGrams}
        onCarbsChange={setCarbsGrams}
        fatGrams={fatGrams}
        onFatChange={setFatGrams}
        servingDescription={servingDescription}
        isWide={isWide}
        isSaving={createMutation.isPending || quickAddMutation.isPending}
        onBack={() => {
          selectedFoodNutrients.current = {};
          setShowForm(false);
        }}
        onSave={handleSave}
      />
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

            {displayResults.map((result) => (
              <FoodResultCard
                key={`${result.source}-${result.name}`}
                result={result}
                onSelect={handleSelectResult}
              />
            ))}

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
                {openFoodFactsResults.map((result) => (
                  <FoodResultCard
                    key={`off-${result.name}`}
                    result={result}
                    onSelect={handleSelectResult}
                    sourceLabel="Open Food Facts"
                  />
                ))}
              </>
            )}

            {/* Manual entry option */}
            <TouchableOpacity
              style={styles.manualEntry}
              onPress={() => {
                selectedFoodNutrients.current = {};
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
        <QuickAddTab
          foodName={foodName}
          onFoodNameChange={setFoodName}
          selectedMeal={selectedMeal}
          onMealChange={setSelectedMeal}
          calories={calories}
          onCaloriesChange={setCalories}
          proteinGrams={proteinGrams}
          onProteinChange={setProteinGrams}
          carbsGrams={carbsGrams}
          onCarbsChange={setCarbsGrams}
          fatGrams={fatGrams}
          onFatChange={setFatGrams}
          isWide={isWide}
          isSaving={quickAddMutation.isPending}
          onSave={handleQuickAddSave}
        />
      )}
    </KeyboardAvoidingView>
  );
}
