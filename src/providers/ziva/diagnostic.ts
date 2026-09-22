// cspell:ignore Ziva
import type { ZivaMealPayload } from "./schemas.ts";

export interface ZivaDiagnosticSummary {
  tools: { get_meals_for_date: boolean };
  mealCount: number;
  mealFields: {
    description: boolean;
    mealDate: boolean;
    mealType: boolean;
    mealTime: boolean;
    createdAt: boolean;
    itemCount: boolean;
    items: boolean;
    macros: boolean;
  };
  itemFields: {
    food: boolean;
    portion: boolean;
    quantity: boolean;
  };
  macroKeys: {
    calories: boolean;
    protein: boolean;
    carbs: boolean;
    fat: boolean;
  };
  presence: {
    mealId: boolean;
    itemId: boolean;
    gramWeight: boolean;
  };
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.hasOwn(value, key);
}

/** Returns presence metadata only; source values and unknown passthrough fields are never copied. */
export function summarizeZivaDiagnostic(
  payload: ZivaMealPayload,
  options: { mealToolPresent: boolean },
): ZivaDiagnosticSummary {
  const meals = payload.meals;
  const items = meals.flatMap((meal) => meal.items);
  const mealHas = (key: string) => meals.some((meal) => hasOwn(meal, key));
  const itemHas = (key: string) => items.some((item) => hasOwn(item, key));
  const macroHas = (key: string) =>
    meals.some((meal) => hasOwn(meal, "macros") && hasOwn(meal.macros, key));

  return {
    tools: { get_meals_for_date: options.mealToolPresent },
    mealCount: meals.length,
    mealFields: {
      description: mealHas("description"),
      mealDate: mealHas("mealDate"),
      mealType: mealHas("mealType"),
      mealTime: mealHas("mealTime"),
      createdAt: mealHas("createdAt"),
      itemCount: mealHas("itemCount"),
      items: mealHas("items"),
      macros: mealHas("macros"),
    },
    itemFields: {
      food: itemHas("food"),
      portion: itemHas("portion"),
      quantity: itemHas("quantity"),
    },
    macroKeys: {
      calories: macroHas("calories"),
      protein: macroHas("protein"),
      carbs: macroHas("carbs"),
      fat: macroHas("fat"),
    },
    presence: {
      mealId: mealHas("mealId"),
      itemId: itemHas("itemId"),
      gramWeight: itemHas("gramWeight"),
    },
  };
}
