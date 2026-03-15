import { useMemo, useState } from "react";
import { AddFoodModal, type FoodFormData, type MealType } from "../components/AddFoodModal.tsx";
import { AppHeader } from "../components/AppHeader.tsx";
import { FoodEntryRow } from "../components/FoodEntryRow.tsx";
import { ChartLoadingSkeleton } from "../components/LoadingSkeleton.tsx";
import { MacroBar } from "../components/MacroBar.tsx";
import { SlackInstallBanner } from "../components/SlackInstallBanner.tsx";
import { formatDateForDisplay, formatDateForQuery, isToday } from "../lib/dates.ts";
import { trpc } from "../lib/trpc.ts";

/** Narrow loosely-typed tRPC raw-SQL results to a known shape without double-casting. */
function typedData<T>(data: unknown): T {
  // @ts-expect-error -- centralized type narrowing for tRPC raw-SQL results
  return data;
}

const CALORIES_PER_GRAM = { protein: 4, carbs: 4, fat: 9 } as const;

const MEAL_ORDER: MealType[] = ["breakfast", "lunch", "dinner", "snack", "other"];

const MEAL_LABELS: Record<MealType, string> = {
  breakfast: "Breakfast",
  lunch: "Lunch",
  dinner: "Dinner",
  snack: "Snack",
  other: "Other",
};

interface FoodEntry {
  id: string;
  food_name: string;
  meal: string;
  calories: number;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  food_description: string | null;
}

export function NutritionPage() {
  const [selectedDate, setSelectedDate] = useState(() => new Date());
  const [modalOpen, setModalOpen] = useState(false);
  const [modalMealType, setModalMealType] = useState<MealType>("breakfast");
  const [collapsedMeals, setCollapsedMeals] = useState<Set<string>>(new Set());

  const calorieGoalQuery = trpc.settings.get.useQuery({ key: "calorieGoal" });
  const calorieGoal = Number(calorieGoalQuery.data?.value ?? 2000);

  const dateString = formatDateForQuery(selectedDate);

  const foodQuery = trpc.food.byDate.useQuery({ date: dateString });
  const createMutation = trpc.food.create.useMutation({
    onSuccess: () => {
      foodQuery.refetch();
      setModalOpen(false);
    },
  });
  const deleteMutation = trpc.food.delete.useMutation({
    onSuccess: () => {
      foodQuery.refetch();
    },
  });

  const entries = typedData<FoodEntry[]>(foodQuery.data ?? []);

  const dailyTotals = useMemo(() => {
    let totalCalories = 0;
    let totalProtein = 0;
    let totalCarbs = 0;
    let totalFat = 0;

    for (const entry of entries) {
      totalCalories += entry.calories;
      totalProtein += entry.protein_g ?? 0;
      totalCarbs += entry.carbs_g ?? 0;
      totalFat += entry.fat_g ?? 0;
    }

    return { totalCalories, totalProtein, totalCarbs, totalFat };
  }, [entries]);

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

  function openAddFood(mealType: MealType) {
    setModalMealType(mealType);
    setModalOpen(true);
  }

  function handleAddFood(data: FoodFormData) {
    createMutation.mutate({
      date: dateString,
      foodName: data.foodName,
      meal: data.meal,
      calories: data.calories,
      proteinG: data.proteinG,
      carbsG: data.carbsG,
      fatG: data.fatG,
      foodDescription: data.foodDescription || null,
    });
  }

  function handleDeleteFood(id: string) {
    deleteMutation.mutate({ id });
  }

  function toggleMeal(mealType: string) {
    setCollapsedMeals((prev) => {
      const next = new Set(prev);
      if (next.has(mealType)) next.delete(mealType);
      else next.add(mealType);
      return next;
    });
  }

  const calorieProgress = Math.min((dailyTotals.totalCalories / calorieGoal) * 100, 100);
  const calorieColor = dailyTotals.totalCalories > calorieGoal ? "bg-red-500" : "bg-emerald-500";

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 overflow-x-hidden">
      <AppHeader />

      <main className="mx-auto max-w-3xl px-3 sm:px-6 py-4 sm:py-6 space-y-6">
        {/* Date selector */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={goToPreviousDay}
              className="rounded-lg p-2 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
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
              className="rounded-lg p-2 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
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
              className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 hover:bg-zinc-800 transition-colors"
            >
              Today
            </button>
          )}
        </div>

        <SlackInstallBanner />

        {/* Daily summary */}
        <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-5 space-y-5">
          <div className="space-y-2">
            <div className="flex items-baseline justify-between">
              <span className="text-sm font-medium text-zinc-400">Calories</span>
              <span className="text-sm text-zinc-400 tabular-nums">
                <span className="text-xl font-semibold text-zinc-100">
                  {dailyTotals.totalCalories}
                </span>
                <span className="ml-1">/ {calorieGoal} kcal</span>
              </span>
            </div>
            <div className="h-3 rounded-full bg-zinc-800 overflow-hidden">
              <div
                className={`h-full rounded-full ${calorieColor} transition-all duration-300`}
                style={{ width: `${calorieProgress}%` }}
              />
            </div>
            <div className="text-xs text-zinc-500 tabular-nums">
              {calorieGoal - dailyTotals.totalCalories > 0
                ? `${calorieGoal - dailyTotals.totalCalories} kcal remaining`
                : `${dailyTotals.totalCalories - calorieGoal} kcal over goal`}
            </div>
          </div>

          {/* Macro bars */}
          <div className="space-y-3">
            <MacroBar
              label="Protein"
              grams={Math.round(dailyTotals.totalProtein)}
              caloriesFromMacro={dailyTotals.totalProtein * CALORIES_PER_GRAM.protein}
              totalCalories={dailyTotals.totalCalories}
              color="blue"
            />
            <MacroBar
              label="Carbs"
              grams={Math.round(dailyTotals.totalCarbs)}
              caloriesFromMacro={dailyTotals.totalCarbs * CALORIES_PER_GRAM.carbs}
              totalCalories={dailyTotals.totalCalories}
              color="amber"
            />
            <MacroBar
              label="Fat"
              grams={Math.round(dailyTotals.totalFat)}
              caloriesFromMacro={dailyTotals.totalFat * CALORIES_PER_GRAM.fat}
              totalCalories={dailyTotals.totalCalories}
              color="red"
            />
          </div>
        </div>

        {/* Loading state */}
        {foodQuery.isLoading && <ChartLoadingSkeleton height={200} />}

        {/* Meal sections */}
        {!foodQuery.isLoading &&
          MEAL_ORDER.map((mealType) => {
            const mealEntries = mealGroups.get(mealType) ?? [];
            const mealCalories = mealEntries.reduce((sum, e) => sum + e.calories, 0);
            const isCollapsed = collapsedMeals.has(mealType);

            return (
              <div
                key={mealType}
                className="rounded-xl border border-zinc-800 bg-zinc-900 overflow-hidden"
              >
                {/* Meal header */}
                <button
                  type="button"
                  onClick={() => toggleMeal(mealType)}
                  className="w-full flex items-center justify-between px-5 py-3 hover:bg-zinc-800/50 transition-colors"
                >
                  <div className="flex items-center gap-2">
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      viewBox="0 0 20 20"
                      fill="currentColor"
                      className={`w-4 h-4 text-zinc-500 transition-transform ${isCollapsed ? "" : "rotate-90"}`}
                    >
                      <title>Toggle meal section</title>
                      <path
                        fillRule="evenodd"
                        d="M8.22 5.22a.75.75 0 011.06 0l4.25 4.25a.75.75 0 010 1.06l-4.25 4.25a.75.75 0 01-1.06-1.06L11.94 10 8.22 6.28a.75.75 0 010-1.06z"
                        clipRule="evenodd"
                      />
                    </svg>
                    <span className="text-sm font-medium text-zinc-200">
                      {MEAL_LABELS[mealType]}
                    </span>
                    {mealEntries.length > 0 && (
                      <span className="text-xs text-zinc-500">
                        ({mealEntries.length} {mealEntries.length === 1 ? "item" : "items"})
                      </span>
                    )}
                  </div>
                  <span className="text-sm text-zinc-400 tabular-nums">
                    {mealCalories > 0 ? `${mealCalories} kcal` : ""}
                  </span>
                </button>

                {/* Meal entries */}
                {!isCollapsed && (
                  <div className="border-t border-zinc-800">
                    {mealEntries.length > 0 ? (
                      <div className="px-2 py-1">
                        {mealEntries.map((entry) => (
                          <FoodEntryRow
                            key={entry.id}
                            foodName={entry.food_name}
                            servingDescription={entry.food_description}
                            calories={entry.calories}
                            onDelete={() => handleDeleteFood(entry.id)}
                            deleting={deleteMutation.isPending}
                          />
                        ))}
                      </div>
                    ) : (
                      <div className="px-5 py-4 text-sm text-zinc-600">No entries yet</div>
                    )}

                    {/* Add food button */}
                    <div className="border-t border-zinc-800 px-5 py-2">
                      <button
                        type="button"
                        onClick={() => openAddFood(mealType)}
                        className="text-sm text-emerald-400 hover:text-emerald-300 transition-colors"
                      >
                        + Add food
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
      </main>

      <AddFoodModal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        onSubmit={handleAddFood}
        defaultMealType={modalMealType}
        submitting={createMutation.isPending}
      />
    </div>
  );
}
