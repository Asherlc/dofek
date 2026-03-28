import { MEAL_OPTIONS, type MealType } from "@dofek/nutrition/meal";
import { useEffect, useMemo, useRef, useState } from "react";
import { type FoodDatabaseResult, OpenFoodFactsClient } from "../lib/food-database.ts";
import { captureException } from "../lib/telemetry.ts";
import { trpc } from "../lib/trpc.ts";

export type { MealType } from "@dofek/nutrition/meal";

export interface FoodFormData {
  foodName: string;
  meal: MealType;
  calories: number;
  proteinG: number | null;
  carbsG: number | null;
  fatG: number | null;
  foodDescription: string;
  /** Micronutrient data keyed by nutrient id (e.g. 'vitamin_a' → 150) */
  nutrients: Record<string, number>;
}

interface AddFoodModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (data: FoodFormData) => void;
  defaultMealType?: MealType;
  submitting?: boolean;
}

/** Convert a tRPC food.search row into the FoodDatabaseResult shape used by applySearchResult */
function historyRowToFoodResult(row: {
  food_name: string;
  food_description: string | null;
  category: string | null;
  calories: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  fiber_g: number | null;
  number_of_units: number | null;
}): FoodDatabaseResult {
  return {
    barcode: null,
    name: row.food_name,
    brand: null,
    servingSize: row.food_description,
    calories: row.calories,
    proteinG: row.protein_g,
    carbsG: row.carbs_g,
    fatG: row.fat_g,
    fiberG: row.fiber_g,
    imageUrl: null,
    nutrients: {},
  };
}

export function AddFoodModal({
  isOpen,
  onClose,
  onSubmit,
  defaultMealType = "breakfast",
  submitting = false,
}: AddFoodModalProps) {
  const [foodName, setFoodName] = useState("");
  const [mealType, setMealType] = useState<MealType>(defaultMealType);
  const [calories, setCalories] = useState("");
  const [proteinGrams, setProteinGrams] = useState("");
  const [carbsGrams, setCarbsGrams] = useState("");
  const [fatGrams, setFatGrams] = useState("");
  const [servingDescription, setServingDescription] = useState("");
  const [showMacros, setShowMacros] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [historyResults, setHistoryResults] = useState<FoodDatabaseResult[]>([]);
  const [searchingHistory, setSearchingHistory] = useState(false);
  const [openFoodFactsResults, setOpenFoodFactsResults] = useState<FoodDatabaseResult[]>([]);
  const [searchingOpenFoodFacts, setSearchingOpenFoodFacts] = useState(false);
  const [openFoodFactsSearched, setOpenFoodFactsSearched] = useState(false);
  const [openFoodFactsSectionOpen, setOpenFoodFactsSectionOpen] = useState(true);

  const nameInputRef = useRef<HTMLInputElement>(null);
  const historyRequestCounterRef = useRef(0);
  const skipNextSearchRef = useRef(false);
  const selectedFoodNutrients = useRef<Record<string, number>>({});
  const openFoodFactsRequestCounterRef = useRef(0);
  const browserLocale = typeof navigator !== "undefined" ? navigator.language : "en-US";
  const foodClient = useMemo(() => new OpenFoodFactsClient(browserLocale), [browserLocale]);

  const trpcUtils = trpc.useUtils();

  const analyzeMutation = trpc.food.analyzeWithAi.useMutation({
    onSuccess: (data) => {
      const { nutrition } = data;
      setFoodName(nutrition.foodName);
      setServingDescription(nutrition.foodDescription);
      setCalories(String(nutrition.calories));
      setProteinGrams(String(nutrition.proteinG));
      setCarbsGrams(String(nutrition.carbsG));
      setFatGrams(String(nutrition.fatG));
      setShowMacros(true);
      setAiError(null);
    },
    onError: (error) => {
      setAiError(error.message);
    },
  });

  useEffect(() => {
    if (isOpen) {
      setMealType(defaultMealType);
      nameInputRef.current?.focus();
    }
  }, [isOpen, defaultMealType]);

  function resetForm() {
    historyRequestCounterRef.current += 1;
    openFoodFactsRequestCounterRef.current += 1;
    skipNextSearchRef.current = false;
    selectedFoodNutrients.current = {};
    setFoodName("");
    setCalories("");
    setProteinGrams("");
    setCarbsGrams("");
    setFatGrams("");
    setServingDescription("");
    setShowMacros(false);
    setAiError(null);
    setHistoryResults([]);
    setSearchingHistory(false);
    setOpenFoodFactsResults([]);
    setSearchingOpenFoodFacts(false);
    setOpenFoodFactsSearched(false);
    setOpenFoodFactsSectionOpen(true);
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const parsedCalories = Number.parseInt(calories, 10);
    if (!foodName.trim() || Number.isNaN(parsedCalories)) return;

    onSubmit({
      foodName: foodName.trim(),
      meal: mealType,
      calories: parsedCalories,
      proteinG: proteinGrams ? Number.parseFloat(proteinGrams) : null,
      carbsG: carbsGrams ? Number.parseFloat(carbsGrams) : null,
      fatG: fatGrams ? Number.parseFloat(fatGrams) : null,
      foodDescription: servingDescription.trim(),
      nutrients: selectedFoodNutrients.current,
    });
    resetForm();
  }

  function handleClose() {
    resetForm();
    onClose();
  }

  const handleCloseRef = useRef(handleClose);
  handleCloseRef.current = handleClose;

  useEffect(() => {
    if (!isOpen) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") handleCloseRef.current();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [isOpen]);

  function handleAnalyze() {
    if (!foodName.trim()) return;
    setAiError(null);
    analyzeMutation.mutate({ description: foodName.trim() });
  }

  function applySearchResult(result: FoodDatabaseResult) {
    skipNextSearchRef.current = true;
    selectedFoodNutrients.current = result.nutrients;
    const selectedName = result.brand ? `${result.name} (${result.brand})` : result.name;
    setFoodName(selectedName);
    setServingDescription(result.servingSize ?? "");
    setCalories(result.calories != null ? String(result.calories) : "");
    setProteinGrams(result.proteinG != null ? String(result.proteinG) : "");
    setCarbsGrams(result.carbsG != null ? String(result.carbsG) : "");
    setFatGrams(result.fatG != null ? String(result.fatG) : "");
    setShowMacros(result.proteinG != null || result.carbsG != null || result.fatG != null);
    setHistoryResults([]);
    setSearchingHistory(false);
    setOpenFoodFactsResults([]);
    setOpenFoodFactsSearched(false);
  }

  function handleSearchFoodDatabase() {
    const query = foodName.trim();
    if (query.length < 2) return;

    const requestId = openFoodFactsRequestCounterRef.current + 1;
    openFoodFactsRequestCounterRef.current = requestId;
    setSearchingOpenFoodFacts(true);
    setOpenFoodFactsSearched(true);
    setOpenFoodFactsSectionOpen(true);

    foodClient
      .searchFoods(query, 8)
      .then((results) => {
        if (openFoodFactsRequestCounterRef.current !== requestId) return;
        setOpenFoodFactsResults(results);
        setSearchingOpenFoodFacts(false);
      })
      .catch((error: unknown) => {
        captureException(error, { context: "open-food-facts-search" });
        if (openFoodFactsRequestCounterRef.current !== requestId) return;
        setOpenFoodFactsResults([]);
        setSearchingOpenFoodFacts(false);
      });
  }

  // Debounced history search via tRPC food.search
  useEffect(() => {
    if (!isOpen) return;

    const query = foodName.trim();
    if (query.length < 2) {
      historyRequestCounterRef.current += 1;
      setHistoryResults([]);
      setSearchingHistory(false);
      return;
    }

    if (skipNextSearchRef.current) {
      skipNextSearchRef.current = false;
      return;
    }

    const requestId = historyRequestCounterRef.current + 1;
    historyRequestCounterRef.current = requestId;
    setSearchingHistory(true);

    // Clear Open Food Facts results when query changes (user needs to explicitly re-search)
    setOpenFoodFactsResults([]);
    setOpenFoodFactsSearched(false);
    setSearchingOpenFoodFacts(false);
    openFoodFactsRequestCounterRef.current += 1;

    const controller = new AbortController();

    const timer = setTimeout(() => {
      trpcUtils.food.search
        .fetch({ query, limit: 8 })
        .then((rows) => {
          if (historyRequestCounterRef.current !== requestId) return;
          setHistoryResults(rows.map(historyRowToFoodResult));
          setSearchingHistory(false);
        })
        .catch((error: unknown) => {
          captureException(error, { context: "food-history-search" });
          if (historyRequestCounterRef.current !== requestId) return;
          setHistoryResults([]);
          setSearchingHistory(false);
        });
    }, 250);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [foodName, isOpen, trpcUtils.food.search]);

  if (!isOpen) return null;

  const inputClass =
    "w-full rounded-lg border border-border-strong bg-accent/10 px-3 py-2 text-sm text-foreground placeholder-subtle focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent";

  const queryLongEnough = foodName.trim().length >= 2;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Overlay */}
      <button
        type="button"
        tabIndex={-1}
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={handleClose}
        aria-label="Close modal overlay"
      />

      {/* Modal */}
      <div className="relative w-full max-w-md rounded-xl border border-border bg-surface-solid shadow-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <h2 className="text-lg font-semibold text-foreground">Add Food</h2>
          <button
            type="button"
            onClick={handleClose}
            className="text-subtle hover:text-foreground transition-colors"
            aria-label="Close"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 20 20"
              fill="currentColor"
              className="w-5 h-5"
            >
              <title>Close</title>
              <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-5 py-4 space-y-4">
          {/* Food name + AI analyze */}
          <div>
            <label htmlFor="food-name" className="block text-sm font-medium text-muted mb-1">
              What did you eat? *
            </label>
            <div className="flex gap-2">
              <input
                ref={nameInputRef}
                id="food-name"
                type="text"
                required
                value={foodName}
                onChange={(e) => setFoodName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    handleAnalyze();
                  }
                }}
                placeholder='e.g. "big plate of roasted vegetables"'
                className={inputClass}
              />
              <button
                type="button"
                onClick={handleAnalyze}
                disabled={analyzeMutation.isPending || !foodName.trim()}
                className="shrink-0 rounded-lg bg-violet-600 px-3 py-2 text-sm font-medium text-white hover:bg-violet-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                title="Estimate nutrition with AI (Cmd+Enter)"
              >
                {analyzeMutation.isPending ? (
                  <svg
                    className="animate-spin h-4 w-4"
                    xmlns="http://www.w3.org/2000/svg"
                    fill="none"
                    viewBox="0 0 24 24"
                  >
                    <title>Analyzing</title>
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                    />
                  </svg>
                ) : (
                  "AI"
                )}
              </button>
            </div>
          </div>

          {aiError && (
            <div className="rounded-lg bg-red-950/50 border border-red-800 px-3 py-2 text-sm text-red-300">
              {aiError}
            </div>
          )}

          {/* Your History results (auto-search via tRPC) */}
          {queryLongEnough && (searchingHistory || historyResults.length > 0) && (
            <div className="rounded-lg border border-border bg-page/60 overflow-hidden">
              <div className="px-3 py-2 border-b border-border text-xs font-medium uppercase tracking-wide text-subtle">
                Your History
              </div>
              {searchingHistory && (
                <div className="px-3 py-3 text-sm text-subtle">Searching...</div>
              )}
              {!searchingHistory && historyResults.length > 0 && (
                <div className="max-h-56 overflow-y-auto">
                  {historyResults.map((result) => {
                    const displayName = result.brand
                      ? `${result.name} (${result.brand})`
                      : result.name;
                    const macroParts = [
                      result.proteinG != null ? `Protein ${result.proteinG}g` : null,
                      result.carbsG != null ? `Carbs ${result.carbsG}g` : null,
                      result.fatG != null ? `Fat ${result.fatG}g` : null,
                    ].filter((value): value is string => value !== null);
                    return (
                      <button
                        key={`history-${result.name}-${result.servingSize ?? "no-serving"}-${result.calories ?? "no-calories"}`}
                        type="button"
                        onClick={() => applySearchResult(result)}
                        className="w-full px-3 py-2 text-left hover:bg-surface-hover transition-colors border-b border-border last:border-b-0"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="text-sm text-foreground truncate">{displayName}</div>
                            {result.servingSize && (
                              <div className="text-xs text-subtle truncate mt-0.5">
                                {result.servingSize}
                              </div>
                            )}
                            {macroParts.length > 0 && (
                              <div className="text-xs text-subtle mt-1">
                                {macroParts.join(" · ")}
                              </div>
                            )}
                          </div>
                          {result.calories != null && (
                            <div className="text-xs font-semibold text-foreground whitespace-nowrap">
                              {result.calories} cal
                            </div>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Search Food Database button */}
          {queryLongEnough && (
            <button
              type="button"
              onClick={handleSearchFoodDatabase}
              disabled={searchingOpenFoodFacts}
              className="flex items-center gap-2 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {searchingOpenFoodFacts ? (
                <svg
                  className="animate-spin h-4 w-4"
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                >
                  <title>Searching</title>
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                  />
                </svg>
              ) : (
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                  className="w-4 h-4"
                >
                  <title>Search</title>
                  <path
                    fillRule="evenodd"
                    d="M9 3.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM2 9a7 7 0 1112.452 4.391l3.328 3.329a.75.75 0 11-1.06 1.06l-3.329-3.328A7 7 0 012 9z"
                    clipRule="evenodd"
                  />
                </svg>
              )}
              Search Food Database
            </button>
          )}

          {/* Food Database (Open Food Facts) results - collapsible */}
          {openFoodFactsSearched && (
            <div className="rounded-lg border border-border bg-page/60 overflow-hidden">
              <button
                type="button"
                onClick={() => setOpenFoodFactsSectionOpen(!openFoodFactsSectionOpen)}
                className="w-full px-3 py-2 border-b border-border text-xs font-medium uppercase tracking-wide text-subtle flex items-center justify-between hover:bg-surface-hover transition-colors"
              >
                <span>Food Database</span>
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                  className={`w-4 h-4 transition-transform ${openFoodFactsSectionOpen ? "rotate-180" : ""}`}
                >
                  <title>{openFoodFactsSectionOpen ? "Collapse" : "Expand"}</title>
                  <path
                    fillRule="evenodd"
                    d="M5.22 8.22a.75.75 0 011.06 0L10 11.94l3.72-3.72a.75.75 0 111.06 1.06l-4.25 4.25a.75.75 0 01-1.06 0L5.22 9.28a.75.75 0 010-1.06z"
                    clipRule="evenodd"
                  />
                </svg>
              </button>
              {openFoodFactsSectionOpen && (
                <>
                  {searchingOpenFoodFacts && (
                    <div className="px-3 py-3 text-sm text-subtle">Searching...</div>
                  )}
                  {!searchingOpenFoodFacts && openFoodFactsResults.length === 0 && (
                    <div className="px-3 py-3 text-sm text-subtle">No results found</div>
                  )}
                  {!searchingOpenFoodFacts && openFoodFactsResults.length > 0 && (
                    <div className="max-h-56 overflow-y-auto">
                      {openFoodFactsResults.map((result) => {
                        const displayName = result.brand
                          ? `${result.name} (${result.brand})`
                          : result.name;
                        const macroParts = [
                          result.proteinG != null ? `Protein ${result.proteinG}g` : null,
                          result.carbsG != null ? `Carbs ${result.carbsG}g` : null,
                          result.fatG != null ? `Fat ${result.fatG}g` : null,
                        ].filter((value): value is string => value !== null);
                        return (
                          <button
                            key={`off-${result.barcode ?? "no-barcode"}-${result.name}-${result.brand ?? "no-brand"}-${result.servingSize ?? "no-serving"}-${result.calories ?? "no-calories"}`}
                            type="button"
                            onClick={() => applySearchResult(result)}
                            className="w-full px-3 py-2 text-left hover:bg-surface-hover transition-colors border-b border-border last:border-b-0"
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className="text-sm text-foreground truncate">
                                  {displayName}
                                </div>
                                {result.servingSize && (
                                  <div className="text-xs text-subtle truncate mt-0.5">
                                    {result.servingSize}
                                  </div>
                                )}
                                {macroParts.length > 0 && (
                                  <div className="text-xs text-subtle mt-1">
                                    {macroParts.join(" · ")}
                                  </div>
                                )}
                              </div>
                              {result.calories != null && (
                                <div className="text-xs font-semibold text-foreground whitespace-nowrap">
                                  {result.calories} cal
                                </div>
                              )}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* Meal type */}
          <div>
            <label htmlFor="meal-type" className="block text-sm font-medium text-muted mb-1">
              Meal
            </label>
            <select
              id="meal-type"
              value={mealType}
              onChange={(e) => {
                const val = e.target.value;
                if (
                  val === "breakfast" ||
                  val === "lunch" ||
                  val === "dinner" ||
                  val === "snack" ||
                  val === "other"
                ) {
                  setMealType(val);
                }
              }}
              className={inputClass}
            >
              {MEAL_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          {/* Calories */}
          <div>
            <label htmlFor="calories" className="block text-sm font-medium text-muted mb-1">
              Calories *
            </label>
            <input
              id="calories"
              type="number"
              required
              min="0"
              value={calories}
              onChange={(e) => setCalories(e.target.value)}
              placeholder="e.g. 250"
              className={inputClass}
            />
          </div>

          {/* Serving description */}
          <div>
            <label
              htmlFor="serving-description"
              className="block text-sm font-medium text-muted mb-1"
            >
              Serving description
            </label>
            <input
              id="serving-description"
              type="text"
              value={servingDescription}
              onChange={(e) => setServingDescription(e.target.value)}
              placeholder="e.g. 6 oz grilled"
              className={inputClass}
            />
          </div>

          {/* Toggle macros */}
          {!showMacros && (
            <button
              type="button"
              onClick={() => setShowMacros(true)}
              className="text-sm text-emerald-400 hover:text-emerald-300 transition-colors"
            >
              + Add macros (protein, carbs, fat)
            </button>
          )}

          {/* Macro fields */}
          {showMacros && (
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label htmlFor="protein" className="block text-sm font-medium text-muted mb-1">
                  Protein (g)
                </label>
                <input
                  id="protein"
                  type="number"
                  min="0"
                  step="0.1"
                  value={proteinGrams}
                  onChange={(e) => setProteinGrams(e.target.value)}
                  className={inputClass}
                />
              </div>
              <div>
                <label htmlFor="carbs" className="block text-sm font-medium text-muted mb-1">
                  Carbs (g)
                </label>
                <input
                  id="carbs"
                  type="number"
                  min="0"
                  step="0.1"
                  value={carbsGrams}
                  onChange={(e) => setCarbsGrams(e.target.value)}
                  className={inputClass}
                />
              </div>
              <div>
                <label htmlFor="fat" className="block text-sm font-medium text-muted mb-1">
                  Fat (g)
                </label>
                <input
                  id="fat"
                  type="number"
                  min="0"
                  step="0.1"
                  value={fatGrams}
                  onChange={(e) => setFatGrams(e.target.value)}
                  className={inputClass}
                />
              </div>
            </div>
          )}

          {/* Actions */}
          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={handleClose}
              className="rounded-lg px-4 py-2 text-sm font-medium text-muted hover:text-foreground transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || !foodName.trim() || !calories}
              className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {submitting ? "Saving..." : "Add Food"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
