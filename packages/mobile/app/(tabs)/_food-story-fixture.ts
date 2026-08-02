import type { QueryClient } from "@tanstack/react-query";

export function seedFoodStoryQuery(queryClient: QueryClient, date: string): void {
  queryClient.setQueryData([["food", "byDateV2"], { input: { date }, type: "query" }], {
    entries: [
      {
        id: "food-1",
        food_name: "Overnight oats",
        food_description: "1 cup with berries and almond butter",
        meal: "breakfast",
        calories: 420,
        protein_g: 16,
        carbs_g: 58,
        fat_g: 14,
      },
      {
        id: "food-2",
        food_name: "Protein shake",
        food_description: "Whey isolate, banana",
        meal: "breakfast",
        calories: 210,
        protein_g: 28,
        carbs_g: 18,
        fat_g: 3,
      },
      {
        id: "food-3",
        food_name: "Chicken rice bowl",
        food_description: "Grilled chicken, jasmine rice, broccoli",
        meal: "lunch",
        calories: 640,
        protein_g: 48,
        carbs_g: 62,
        fat_g: 16,
      },
      {
        id: "food-4",
        food_name: "Greek yogurt",
        food_description: "Plain, honey, walnuts",
        meal: "snack",
        calories: 240,
        protein_g: 18,
        carbs_g: 20,
        fat_g: 10,
      },
      {
        id: "food-5",
        food_name: "Salmon and quinoa",
        food_description: "Roasted salmon, quinoa, asparagus",
        meal: "dinner",
        calories: 710,
        protein_g: 52,
        carbs_g: 44,
        fat_g: 28,
      },
    ],
    resolution: {
      status: "available",
      message: "Totals use the only available nutrition source.",
      sourceProviders: ["dofek"],
      contributingProviders: ["dofek"],
      excludedProviders: [],
      sourceLabels: ["dofek"],
      contributingSourceLabels: ["dofek"],
      excludedSourceLabels: [],
      contributionGrain: "itemized",
      contributionLabel: "Dofek itemized entries",
    },
    intakeContext: {
      observedCalories: 2220,
      target: {
        calories: 2200,
        type: "default",
        label: "Default daily logged-intake target",
      },
      scale: {
        maximumCalories: 2220,
        observedPercentage: 100,
        targetPercentage: 99.09909909909909,
      },
      comparison: {
        status: "above_target",
        differenceCalories: 20,
        message: "Observed logged intake is 20 kcal above the default daily logged-intake target.",
      },
      limitation:
        "This target describes logged intake only; it is not an estimate of energy expenditure or calorie balance.",
    },
    summary: {
      calories: 2220,
      mealCalories: {
        breakfast: 630,
        lunch: 640,
        dinner: 710,
        snack: 240,
        other: 0,
      },
      calorieGoal: {
        target: 2200,
        remaining: 0,
        over: 20,
        progressPercentage: 100,
      },
      macros: {
        protein: { grams: 162, calories: 648, energySharePercentage: 31 },
        carbs: { grams: 202, calories: 808, energySharePercentage: 39 },
        fat: { grams: 71, calories: 639, energySharePercentage: 30 },
      },
    },
  });
}
