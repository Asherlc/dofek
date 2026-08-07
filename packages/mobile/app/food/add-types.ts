import type { FoodDatabaseResult } from "@dofek/nutrition/open-food-facts";
import { z } from "zod";

export type LoggerTab = "search" | "scan" | "quickadd" | "ai";

/** Schema for food entries returned from the API */
export const FoodEntrySchema = z.object({
  food_name: z.string(),
  calories: z.number().nullable().optional(),
  protein_g: z.number().nullable().optional(),
  carbs_g: z.number().nullable().optional(),
  fat_g: z.number().nullable().optional(),
  food_description: z.string().nullable().optional(),
});

export const TABS: { key: LoggerTab; label: string }[] = [
  { key: "search", label: "Search" },
  { key: "scan", label: "Scan" },
  { key: "quickadd", label: "Quick Add" },
  { key: "ai", label: "AI" },
];

/** Parse a numeric string, returning null for empty/invalid input instead of NaN. */
export function safeParseFloat(value: string): number | null {
  if (!value) return null;
  const parsed = Number.parseFloat(value);
  return Number.isNaN(parsed) ? null : parsed;
}

// Merged search result from our DB + Open Food Facts
export interface SearchResult {
  source: "history" | "openfoodfacts";
  name: string;
  brand: string | null;
  calories: number | null;
  proteinG: number | null;
  carbsG: number | null;
  fatG: number | null;
  servingDescription: string | null;
  barcode: string | null;
  /** Original Open Food Facts result with full micronutrient data */
  openFoodFactsData?: FoodDatabaseResult;
}
