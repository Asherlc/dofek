export type MealType = "breakfast" | "lunch" | "dinner" | "snack" | "other";

export const MEAL_OPTIONS: ReadonlyArray<{ value: MealType; label: string }> = [
  { value: "breakfast", label: "Breakfast" },
  { value: "lunch", label: "Lunch" },
  { value: "dinner", label: "Dinner" },
  { value: "snack", label: "Snack" },
  { value: "other", label: "Other" },
];
