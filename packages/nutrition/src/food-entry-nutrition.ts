import { NUTRIENTS, type NutrientCategory } from "./nutrients";

export interface FoodEntryNutrientDetail {
  readonly id: string;
  readonly label: string;
  readonly amount: number;
  readonly unit: string;
  readonly category: NutrientCategory;
  readonly sortOrder: number;
  readonly valueText: string;
}

export interface FoodEntryNutrientGroup {
  readonly label: string;
  readonly nutrients: FoodEntryNutrientDetail[];
}

const CATEGORY_LABELS: Record<NutrientCategory, string> = {
  macro: "Macros",
  fat_breakdown: "Fats",
  other_macro: "Other nutrients",
  vitamin: "Vitamins",
  mineral: "Minerals",
  fatty_acid: "Fatty acids",
  stimulant: "Stimulants",
  hydration: "Hydration",
};

const CATEGORY_ORDER: readonly NutrientCategory[] = [
  "macro",
  "fat_breakdown",
  "other_macro",
  "vitamin",
  "mineral",
  "fatty_acid",
  "stimulant",
  "hydration",
];

function formatNutrientAmount(amount: number, unit: string): string {
  const rounded = Number.isInteger(amount) ? String(amount) : amount.toFixed(1);
  return `${rounded} ${unit}`;
}

export function foodEntryNutrientDetailsFromLegacyColumns(
  row: Record<string, unknown>,
): FoodEntryNutrientDetail[] {
  const details: FoodEntryNutrientDetail[] = [];

  for (const nutrient of NUTRIENTS) {
    const amount = row[nutrient.legacyColumnName];
    if (typeof amount !== "number" || !Number.isFinite(amount)) continue;

    details.push({
      id: nutrient.id,
      label: nutrient.displayName,
      amount,
      unit: nutrient.unit,
      category: nutrient.category,
      sortOrder: nutrient.sortOrder,
      valueText: formatNutrientAmount(amount, nutrient.unit),
    });
  }

  return details.sort((first, second) => first.sortOrder - second.sortOrder);
}

export function groupFoodEntryNutrientDetails(
  details: readonly FoodEntryNutrientDetail[],
): FoodEntryNutrientGroup[] {
  const groups = new Map<NutrientCategory, FoodEntryNutrientDetail[]>();

  for (const detail of details) {
    const existing = groups.get(detail.category) ?? [];
    existing.push(detail);
    groups.set(detail.category, existing);
  }

  return CATEGORY_ORDER.flatMap((category) => {
    const nutrients = groups.get(category);
    return nutrients ? [{ label: CATEGORY_LABELS[category], nutrients }] : [];
  });
}
