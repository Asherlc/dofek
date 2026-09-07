import {
  formatCalories,
  formatDateForDisplay,
  formatDateYmd as formatDateForQuery,
  isToday,
} from "@dofek/format/format";
import {
  type FoodEntryNutrientDetail,
  foodEntryNutrientDetailsFromLegacyColumns,
} from "@dofek/nutrition/food-entry-nutrition";
import {
  nutritionSourceResolutionSchema,
  selectedDateNutritionIntakeContextSchema,
  selectedDateNutritionSummarySchema,
} from "@dofek/nutrition/selected-date-summary";
import { shouldShowBlockingLoading } from "@dofek/scoring/loading-policy";
import { useMemo, useState } from "react";
import { z } from "zod";
import { FoodEntryRow } from "../components/FoodEntryRow.tsx";
import { ChartLoadingSkeleton } from "../components/LoadingSkeleton.tsx";
import { MacroBar } from "../components/MacroBar.tsx";
import { NutritionIntakeContext } from "../components/NutritionIntakeContext.tsx";
import { QueryStatePanel } from "../components/QueryStatePanel.tsx";
import { trpc } from "../lib/trpc.ts";

const MEAL_ORDER = ["breakfast", "lunch", "dinner", "snack", "other"] as const;

const MEAL_LABELS: Record<(typeof MEAL_ORDER)[number], string> = {
  breakfast: "Breakfast",
  lunch: "Lunch",
  dinner: "Dinner",
  snack: "Snack",
  other: "Other",
};

export const foodEntrySchema = z
  .object({
    id: z.string(),
    food_name: z.string().nullable(),
    meal: z.string().nullable(),
    calories: z.number().nullable(),
    protein_g: z.number().nullable(),
    carbs_g: z.number().nullable(),
    fat_g: z.number().nullable(),
    food_description: z.string().nullable(),
  })
  .passthrough();
export type FoodEntry = z.infer<typeof foodEntrySchema>;

export const selectedDateFoodSchema = z.object({
  entries: z.array(foodEntrySchema),
  summary: selectedDateNutritionSummarySchema,
});

export const selectedDateFoodV2Schema = z.object({
  entries: z.array(foodEntrySchema),
  summary: selectedDateNutritionSummarySchema.nullable(),
  resolution: nutritionSourceResolutionSchema,
  intakeContext: selectedDateNutritionIntakeContextSchema.nullable(),
});

export function getFoodEntryNutrientDetails(entry: FoodEntry): FoodEntryNutrientDetail[] {
  return foodEntryNutrientDetailsFromLegacyColumns(entry);
}

export function NutritionPage() {
  const [selectedDate, setSelectedDate] = useState(() => new Date());
  const [collapsedMeals, setCollapsedMeals] = useState<Set<string>>(new Set());

  const dateString = formatDateForQuery(selectedDate);

  const foodQuery = trpc.food.byDateV2.useQuery(
    { date: dateString },
    { placeholderData: (previousData) => previousData },
  );
  const selectedDateFood =
    foodQuery.data === undefined ? undefined : selectedDateFoodV2Schema.parse(foodQuery.data);
  const entries = selectedDateFood?.entries ?? [];
  const isFoodBlockingLoading = shouldShowBlockingLoading({
    data: entries,
    isFetching: foodQuery.isFetching,
    isLoading: foodQuery.isLoading,
  });

  const mealGroups = useMemo(() => {
    const groups = new Map<string, FoodEntry[]>();
    for (const entry of entries) {
      const meal = entry.meal || "other";
      const existing = groups.get(meal) ?? [];
      existing.push(entry);
      groups.set(meal, existing);
    }
    return groups;
  }, [entries]);

  function goToPreviousDay() {
    setSelectedDate((prev) => {
      const next = new Date(prev);
      next.setDate(next.getDate() - 1);
      return next;
    });
  }

  function goToNextDay() {
    setSelectedDate((prev) => {
      const next = new Date(prev);
      next.setDate(next.getDate() + 1);
      return next;
    });
  }

  function goToToday() {
    setSelectedDate(new Date());
  }

  function toggleMeal(mealType: string) {
    setCollapsedMeals((prev) => {
      const next = new Set(prev);
      if (next.has(mealType)) next.delete(mealType);
      else next.add(mealType);
      return next;
    });
  }

  return (
    <div className="mx-auto max-w-3xl px-3 sm:px-6 py-4 sm:py-6 space-y-6">
      {/* Date selector */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={goToPreviousDay}
            className="rounded-lg p-2 text-muted hover:text-foreground hover:bg-accent/10 transition-colors"
            aria-label="Previous day"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 20 20"
              fill="currentColor"
              className="w-5 h-5"
            >
              <title>Previous day</title>
              <path
                fillRule="evenodd"
                d="M11.78 5.22a.75.75 0 010 1.06L8.06 10l3.72 3.72a.75.75 0 11-1.06 1.06l-4.25-4.25a.75.75 0 010-1.06l4.25-4.25a.75.75 0 011.06 0z"
                clipRule="evenodd"
              />
            </svg>
          </button>
          <h2 className="text-lg font-semibold">{formatDateForDisplay(selectedDate)}</h2>
          <button
            type="button"
            onClick={goToNextDay}
            className="rounded-lg p-2 text-muted hover:text-foreground hover:bg-accent/10 transition-colors"
            aria-label="Next day"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 20 20"
              fill="currentColor"
              className="w-5 h-5"
            >
              <title>Next day</title>
              <path
                fillRule="evenodd"
                d="M8.22 5.22a.75.75 0 011.06 0l4.25 4.25a.75.75 0 010 1.06l-4.25 4.25a.75.75 0 01-1.06-1.06L11.94 10 8.22 6.28a.75.75 0 010-1.06z"
                clipRule="evenodd"
              />
            </svg>
          </button>
        </div>
        {!isToday(selectedDate) && (
          <button
            type="button"
            onClick={goToToday}
            className="rounded-lg border border-border-strong px-3 py-1.5 text-xs font-medium text-foreground hover:bg-accent/10 transition-colors"
          >
            Today
          </button>
        )}
      </div>

      {/* Loading state */}
      {isFoodBlockingLoading && <ChartLoadingSkeleton height={200} />}

      {foodQuery.error && <QueryStatePanel error={foodQuery.error} height={200} />}

      {selectedDateFood && (
        <>
          {/* Daily summary */}
          {selectedDateFood.intakeContext && (
            <NutritionIntakeContext context={selectedDateFood.intakeContext} />
          )}

          {selectedDateFood.resolution.sourceProviders.length > 0 &&
            selectedDateFood.resolution.status === "available" && (
              <section
                className="rounded-xl border border-border bg-surface-solid px-4 py-3"
                aria-label="Nutrition source resolution"
              >
                <p className="text-xs font-medium uppercase tracking-wide text-subtle">
                  Source coverage
                </p>
                {selectedDateFood.resolution.contributionLabel && (
                  <p className="mt-1 font-medium text-foreground">
                    {selectedDateFood.resolution.contributionLabel}
                  </p>
                )}
                <p className="mt-1 text-sm text-muted">{selectedDateFood.resolution.message}</p>
                {selectedDateFood.resolution.excludedSourceLabels.length > 0 && (
                  <p className="mt-1 text-xs text-subtle">
                    Excluded overlapping sources:{" "}
                    {selectedDateFood.resolution.excludedSourceLabels.join(", ")}
                  </p>
                )}
              </section>
            )}

          {selectedDateFood.resolution.status === "source_conflict" && (
            <div
              role="alert"
              className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-foreground"
            >
              <p className="font-medium">Nutrition source conflict</p>
              <p className="mt-1 text-muted">{selectedDateFood.resolution.message}</p>
              <p className="mt-2 text-xs text-subtle">
                Sources: {selectedDateFood.resolution.sourceLabels.join(", ")}
              </p>
            </div>
          )}

          {selectedDateFood.summary && (
            <section
              className="rounded-xl border border-border bg-surface-solid p-5 space-y-5"
              aria-labelledby="nutrition-composition-heading"
            >
              {/* Macro bars */}
              <div className="space-y-3">
                <p
                  id="nutrition-composition-heading"
                  className="text-xs font-medium uppercase tracking-wide text-subtle"
                >
                  Observed intake composition
                </p>
                <div>
                  <h3 className="text-sm font-medium text-foreground">Share of energy</h3>
                  <p className="text-xs text-subtle">Logged grams are shown separately.</p>
                </div>
                <MacroBar
                  label="Protein"
                  grams={selectedDateFood.summary.macros.protein.grams}
                  energySharePercentage={
                    selectedDateFood.summary.macros.protein.energySharePercentage
                  }
                  color="blue"
                />
                <MacroBar
                  label="Carbs"
                  grams={selectedDateFood.summary.macros.carbs.grams}
                  energySharePercentage={
                    selectedDateFood.summary.macros.carbs.energySharePercentage
                  }
                  color="purple"
                />
                <MacroBar
                  label="Fat"
                  grams={selectedDateFood.summary.macros.fat.grams}
                  energySharePercentage={selectedDateFood.summary.macros.fat.energySharePercentage}
                  color="teal"
                />
              </div>
            </section>
          )}

          {/* Meal sections */}
          {!isFoodBlockingLoading &&
            MEAL_ORDER.map((mealType) => {
              const mealEntries = mealGroups.get(mealType) ?? [];
              const mealCalories = selectedDateFood.summary?.mealCalories[mealType] ?? null;
              const isCollapsed = collapsedMeals.has(mealType);

              return (
                <div
                  key={mealType}
                  className="rounded-xl border border-border bg-surface-solid overflow-hidden"
                >
                  {/* Meal header */}
                  <button
                    type="button"
                    onClick={() => toggleMeal(mealType)}
                    className="w-full flex items-center justify-between px-5 py-3 hover:bg-surface-hover transition-colors"
                  >
                    <div className="flex items-center gap-2">
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        viewBox="0 0 20 20"
                        fill="currentColor"
                        className={`w-4 h-4 text-subtle transition-transform ${isCollapsed ? "" : "rotate-90"}`}
                      >
                        <title>Toggle meal section</title>
                        <path
                          fillRule="evenodd"
                          d="M8.22 5.22a.75.75 0 011.06 0l4.25 4.25a.75.75 0 010 1.06l-4.25 4.25a.75.75 0 01-1.06-1.06L11.94 10 8.22 6.28a.75.75 0 010-1.06z"
                          clipRule="evenodd"
                        />
                      </svg>
                      <span className="text-sm font-medium text-foreground">
                        {MEAL_LABELS[mealType]}
                      </span>
                      {mealEntries.length > 0 && (
                        <span className="text-xs text-subtle">
                          ({mealEntries.length} {mealEntries.length === 1 ? "item" : "items"})
                        </span>
                      )}
                    </div>
                    <span className="text-sm text-muted tabular-nums">
                      {mealCalories != null && mealCalories > 0 ? formatCalories(mealCalories) : ""}
                    </span>
                  </button>

                  {/* Meal entries */}
                  {!isCollapsed && (
                    <div className="border-t border-border">
                      {mealEntries.length > 0 ? (
                        <div className="px-2 py-1">
                          {mealEntries.map((entry) => (
                            <FoodEntryRow
                              key={entry.id}
                              foodName={entry.food_name ?? "Unnamed nutrition entry"}
                              servingDescription={entry.food_description}
                              calories={entry.calories ?? 0}
                              nutrients={getFoodEntryNutrientDetails(entry)}
                            />
                          ))}
                        </div>
                      ) : (
                        <div className="px-5 py-4 text-sm text-dim">No entries yet</div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
        </>
      )}

      <div className="text-center text-xs font-medium text-subtle">
        <a
          href="https://www.fatsecret.com/"
          target="_blank"
          rel="noopener noreferrer"
          className="transition-colors hover:text-foreground"
        >
          Powered by fatsecret Platform API
        </a>
      </div>
    </div>
  );
}
