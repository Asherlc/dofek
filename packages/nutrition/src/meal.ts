export type MealType = "breakfast" | "lunch" | "dinner" | "snack" | "other";

export const MEAL_OPTIONS: ReadonlyArray<{ value: MealType; label: string }> = [
  { value: "breakfast", label: "Breakfast" },
  { value: "lunch", label: "Lunch" },
  { value: "dinner", label: "Dinner" },
  { value: "snack", label: "Snack" },
  { value: "other", label: "Other" },
];

/** Guess the current meal based on the hour of day. */
export function autoMealType(hour?: number): MealType {
  const currentHour = hour ?? new Date().getHours();
  if (currentHour < 10) return "breakfast";
  if (currentHour < 14) return "lunch";
  if (currentHour < 17) return "snack";
  return "dinner";
}

export interface QuickAddFormInput {
  foodName: string;
  calories: string;
  proteinGrams: string;
  carbsGrams: string;
  fatGrams: string;
  meal: MealType;
  date: string;
}

export interface QuickAddPayload {
  date: string;
  meal: MealType;
  foodName: string;
  calories: number;
  proteinG: number | null;
  carbsG: number | null;
  fatG: number | null;
}

/** Parse and validate quick-add form fields. Returns the payload or an error string. */
export function parseQuickAddForm(input: QuickAddFormInput): QuickAddPayload | { error: string } {
  const parsedCalories = Number.parseInt(input.calories, 10);
  if (Number.isNaN(parsedCalories) || parsedCalories <= 0) {
    return { error: "Enter a calorie amount." };
  }

  return {
    date: input.date,
    meal: input.meal,
    foodName: input.foodName.trim() || "Quick Add",
    calories: parsedCalories,
    proteinG: input.proteinGrams ? Number.parseFloat(input.proteinGrams) : null,
    carbsG: input.carbsGrams ? Number.parseFloat(input.carbsGrams) : null,
    fatG: input.fatGrams ? Number.parseFloat(input.fatGrams) : null,
  };
}
