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
