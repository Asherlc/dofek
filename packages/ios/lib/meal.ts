export type MealType = "breakfast" | "lunch" | "dinner" | "snack" | "other";

/** Guess the current meal based on the hour of day. */
export function autoMealType(hour?: number): MealType {
  const h = hour ?? new Date().getHours();
  if (h < 10) return "breakfast";
  if (h < 14) return "lunch";
  if (h < 17) return "snack";
  return "dinner";
}

/** Format a Date as YYYY-MM-DD for API queries. */
export function formatDateYmd(date?: Date): string {
  const d = date ?? new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
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
export function parseQuickAddForm(
  input: QuickAddFormInput,
): QuickAddPayload | { error: string } {
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
