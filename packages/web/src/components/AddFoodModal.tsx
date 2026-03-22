import { MEAL_OPTIONS, type MealType } from "@dofek/nutrition/meal";
import { useEffect, useMemo, useRef, useState } from "react";
import { type FoodDatabaseResult, OpenFoodFactsClient } from "../lib/food-database.ts";
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
}

interface AddFoodModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (data: FoodFormData) => void;
  defaultMealType?: MealType;
  submitting?: boolean;
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
  const [searchResults, setSearchResults] = useState<FoodDatabaseResult[]>([]);
  const [searchingFoods, setSearchingFoods] = useState(false);

  const nameInputRef = useRef<HTMLInputElement>(null);
  const searchRequestCounterRef = useRef(0);
  const skipNextSearchRef = useRef(false);
  const browserLocale = typeof navigator !== "undefined" ? navigator.language : "en-US";
  const foodClient = useMemo(() => new OpenFoodFactsClient(browserLocale), [browserLocale]);

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
    searchRequestCounterRef.current += 1;
    skipNextSearchRef.current = false;
    setFoodName("");
    setCalories("");
    setProteinGrams("");
    setCarbsGrams("");
    setFatGrams("");
    setServingDescription("");
    setShowMacros(false);
    setAiError(null);
    setSearchResults([]);
    setSearchingFoods(false);
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
    });
    resetForm();
  }

  function handleClose() {
    resetForm();
    onClose();
  }

  function handleAnalyze() {
    if (!foodName.trim()) return;
    setAiError(null);
    analyzeMutation.mutate({ description: foodName.trim() });
  }

  function applySearchResult(result: FoodDatabaseResult) {
    skipNextSearchRef.current = true;
    const selectedName = result.brand ? `${result.name} (${result.brand})` : result.name;
    setFoodName(selectedName);
    setServingDescription(result.servingSize ?? "");
    setCalories(result.calories != null ? String(result.calories) : "");
    setProteinGrams(result.proteinG != null ? String(result.proteinG) : "");
    setCarbsGrams(result.carbsG != null ? String(result.carbsG) : "");
    setFatGrams(result.fatG != null ? String(result.fatG) : "");
    setShowMacros(result.proteinG != null || result.carbsG != null || result.fatG != null);
    setSearchResults([]);
    setSearchingFoods(false);
  }

  useEffect(() => {
    if (!isOpen) return;

    const query = foodName.trim();
    if (query.length < 2) {
      searchRequestCounterRef.current += 1;
      setSearchResults([]);
      setSearchingFoods(false);
      return;
    }

    if (skipNextSearchRef.current) {
      skipNextSearchRef.current = false;
      return;
    }

    const requestId = searchRequestCounterRef.current + 1;
    searchRequestCounterRef.current = requestId;
    setSearchingFoods(true);

    const timer = setTimeout(() => {
      foodClient
        .searchFoods(query, 8)
        .then((results) => {
          if (searchRequestCounterRef.current !== requestId) return;
          setSearchResults(results);
          setSearchingFoods(false);
        })
        .catch(() => {
          if (searchRequestCounterRef.current !== requestId) return;
          setSearchResults([]);
          setSearchingFoods(false);
        });
    }, 250);

    return () => {
      clearTimeout(timer);
    };
  }, [foodClient, foodName, isOpen]);

  if (!isOpen) return null;

  const inputClass =
    "w-full rounded-lg border border-border-strong bg-accent/10 px-3 py-2 text-sm text-foreground placeholder-subtle focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Overlay */}
      <button
        type="button"
        tabIndex={-1}
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={handleClose}
        onKeyDown={(e) => {
          if (e.key === "Escape") handleClose();
        }}
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

          {foodName.trim().length >= 2 && (
            <div className="rounded-lg border border-border bg-page/60 overflow-hidden">
              <div className="px-3 py-2 border-b border-border text-xs font-medium uppercase tracking-wide text-subtle">
                Open Food Facts Results
              </div>
              {searchingFoods && <div className="px-3 py-3 text-sm text-subtle">Searching...</div>}
              {!searchingFoods && searchResults.length === 0 && (
                <div className="px-3 py-3 text-sm text-subtle">No results found</div>
              )}
              {!searchingFoods && searchResults.length > 0 && (
                <div className="max-h-56 overflow-y-auto">
                  {searchResults.map((result) => {
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
                        key={`${result.barcode ?? "no-barcode"}-${result.name}-${result.brand ?? "no-brand"}-${result.servingSize ?? "no-serving"}-${result.calories ?? "no-calories"}`}
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
