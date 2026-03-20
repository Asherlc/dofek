import { createHash } from "node:crypto";
import type { SyncDatabase } from "../db/index.ts";
import { foodEntry, nutritionDaily } from "../db/schema.ts";
import { ensureProvider } from "../db/tokens.ts";
import type { ImportProvider, SyncError, SyncResult } from "./types.ts";

// ============================================================
// Constants
// ============================================================

export const CRONOMETER_PROVIDER_ID = "cronometer-csv";

// ============================================================
// Types
// ============================================================

type MealType = "breakfast" | "lunch" | "dinner" | "snack" | "other";

export interface CronometerFoodEntry {
  date: string; // YYYY-MM-DD
  meal: MealType;
  foodName: string;
  amount: number | null;
  unit: string | null;
  category: string | null;
  // Macros
  calories: number | null;
  proteinG: number | null;
  carbsG: number | null;
  fatG: number | null;
  fiberG: number | null;
  // Fat breakdown
  saturatedFatG: number | null;
  polyunsaturatedFatG: number | null;
  monounsaturatedFatG: number | null;
  transFatG: number | null;
  // Other
  cholesterolMg: number | null;
  sodiumMg: number | null;
  potassiumMg: number | null;
  sugarG: number | null;
  // Vitamins
  vitaminAMcg: number | null;
  vitaminCMg: number | null;
  vitaminDMcg: number | null;
  vitaminEMg: number | null;
  vitaminKMcg: number | null;
  vitaminB1Mg: number | null; // Thiamin
  vitaminB2Mg: number | null; // Riboflavin
  vitaminB3Mg: number | null; // Niacin
  vitaminB5Mg: number | null; // Pantothenic Acid
  vitaminB6Mg: number | null;
  vitaminB7Mcg: number | null; // Biotin
  vitaminB9Mcg: number | null; // Folate
  vitaminB12Mcg: number | null;
  // Minerals
  calciumMg: number | null;
  ironMg: number | null;
  magnesiumMg: number | null;
  zincMg: number | null;
  seleniumMcg: number | null;
  copperMg: number | null;
  manganeseMg: number | null;
  chromiumMcg: number | null;
  iodineMcg: number | null;
  // Fatty acids (stored in mg — Cronometer exports grams, multiply by 1000)
  omega3Mg: number | null;
  omega6Mg: number | null;
  // Extra
  waterG: number | null;
  caffeineMg: number | null;
}

// ============================================================
// Pure parsing functions
// ============================================================

/**
 * Parse RFC 4180 CSV fields from a single line, handling quoted fields.
 */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      fields.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields;
}

/**
 * Parse a string as a number, returning null for empty/invalid values.
 */
export function parseOptionalNumber(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const num = Number.parseFloat(trimmed);
  return Number.isNaN(num) ? null : num;
}

/**
 * Map Cronometer meal name to our meal enum.
 */
export function mapCronometerMeal(meal: string): MealType {
  switch (meal.toLowerCase()) {
    case "breakfast":
      return "breakfast";
    case "lunch":
      return "lunch";
    case "dinner":
      return "dinner";
    case "snack":
    case "snacks":
      return "snack";
    default:
      return "other";
  }
}

/**
 * Convert grams to milligrams, returning null if input is null.
 */
function gramsToMg(grams: number | null): number | null {
  if (grams === null) return null;
  return Math.round(grams * 1000 * 100) / 100;
}

// Column indices in the Cronometer Servings CSV export
// Day(0), Meal(1), Food Name(2), Amount(3), Unit(4), Category(5),
// Energy(6), Protein(7), Carbs(8), Fat(9), Fiber(10),
// SatFat(11), PolyFat(12), MonoFat(13), TransFat(14),
// Cholesterol(15), Sodium(16), Potassium(17), Sugar(18),
// VitA(19), VitC(20), VitD(21), VitE(22), VitK(23),
// Thiamin(24), Riboflavin(25), Niacin(26), PantoAcid(27), B6(28),
// Biotin(29), Folate(30), B12(31),
// Calcium(32), Iron(33), Magnesium(34), Zinc(35), Selenium(36),
// Copper(37), Manganese(38), Chromium(39), Iodine(40),
// Omega3(41), Omega6(42), Water(43), Caffeine(44), Alcohol(45)

const MIN_FIELDS = 6; // At minimum we need Day, Meal, Food Name, Amount, Unit, Category

/**
 * Parse a Cronometer Servings CSV export into structured food entries.
 */
export function parseCronometerCsv(csvText: string): CronometerFoodEntry[] {
  // Strip BOM
  const text = csvText.replace(/^\uFEFF/, "");
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");

  if (lines.length <= 1) return [];

  // Skip header
  const dataLines = lines.slice(1);
  const entries: CronometerFoodEntry[] = [];

  for (const line of dataLines) {
    const fields = parseCsvLine(line);
    if (fields.length < MIN_FIELDS) continue;

    const field = (index: number): string => fields[index] ?? "";

    const omega3Grams = parseOptionalNumber(field(41));
    const omega6Grams = parseOptionalNumber(field(42));

    entries.push({
      date: field(0),
      meal: mapCronometerMeal(field(1)),
      foodName: field(2),
      amount: parseOptionalNumber(field(3)),
      unit: field(4) || null,
      category: field(5) || null,
      // Macros
      calories: parseOptionalNumber(field(6)),
      proteinG: parseOptionalNumber(field(7)),
      carbsG: parseOptionalNumber(field(8)),
      fatG: parseOptionalNumber(field(9)),
      fiberG: parseOptionalNumber(field(10)),
      // Fat breakdown
      saturatedFatG: parseOptionalNumber(field(11)),
      polyunsaturatedFatG: parseOptionalNumber(field(12)),
      monounsaturatedFatG: parseOptionalNumber(field(13)),
      transFatG: parseOptionalNumber(field(14)),
      // Other
      cholesterolMg: parseOptionalNumber(field(15)),
      sodiumMg: parseOptionalNumber(field(16)),
      potassiumMg: parseOptionalNumber(field(17)),
      sugarG: parseOptionalNumber(field(18)),
      // Vitamins
      vitaminAMcg: parseOptionalNumber(field(19)),
      vitaminCMg: parseOptionalNumber(field(20)),
      vitaminDMcg: parseOptionalNumber(field(21)),
      vitaminEMg: parseOptionalNumber(field(22)),
      vitaminKMcg: parseOptionalNumber(field(23)),
      vitaminB1Mg: parseOptionalNumber(field(24)), // Thiamin
      vitaminB2Mg: parseOptionalNumber(field(25)), // Riboflavin
      vitaminB3Mg: parseOptionalNumber(field(26)), // Niacin
      vitaminB5Mg: parseOptionalNumber(field(27)), // Pantothenic Acid
      vitaminB6Mg: parseOptionalNumber(field(28)),
      vitaminB7Mcg: parseOptionalNumber(field(29)), // Biotin
      vitaminB9Mcg: parseOptionalNumber(field(30)), // Folate
      vitaminB12Mcg: parseOptionalNumber(field(31)),
      // Minerals
      calciumMg: parseOptionalNumber(field(32)),
      ironMg: parseOptionalNumber(field(33)),
      magnesiumMg: parseOptionalNumber(field(34)),
      zincMg: parseOptionalNumber(field(35)),
      seleniumMcg: parseOptionalNumber(field(36)),
      copperMg: parseOptionalNumber(field(37)),
      manganeseMg: parseOptionalNumber(field(38)),
      chromiumMcg: parseOptionalNumber(field(39)),
      iodineMcg: parseOptionalNumber(field(40)),
      // Fatty acids — convert grams to mg
      omega3Mg: gramsToMg(omega3Grams),
      omega6Mg: gramsToMg(omega6Grams),
      // Extra
      waterG: parseOptionalNumber(field(43)),
      caffeineMg: parseOptionalNumber(field(44)),
    });
  }

  return entries;
}

// ============================================================
// Import function
// ============================================================

/**
 * Import Cronometer CSV data into the database.
 * Upserts individual food entries and aggregates daily nutrition totals.
 */
export async function importCronometerCsv(
  db: SyncDatabase,
  csvText: string,
  userId?: string,
): Promise<SyncResult> {
  const start = Date.now();
  const errors: SyncError[] = [];
  let recordsSynced = 0;

  const { DEFAULT_USER_ID } = await import("../db/schema.ts");
  const effectiveUserId = userId ?? DEFAULT_USER_ID;

  await ensureProvider(db, CRONOMETER_PROVIDER_ID, "Cronometer");

  const entries = parseCronometerCsv(csvText);

  // Track daily aggregates for nutritionDaily
  const dailyAggregates = new Map<
    string,
    { calories: number; proteinG: number; carbsG: number; fatG: number; fiberG: number }
  >();

  for (const entry of entries) {
    try {
      // Generate deterministic external ID from date + meal + foodName + amount
      const hashInput = `${entry.date}|${entry.meal}|${entry.foodName}|${entry.amount ?? ""}`;
      const externalId = `cronometer:${createHash("sha256").update(hashInput).digest("hex").slice(0, 16)}`;

      // Round calories to integer for the integer column
      const caloriesInt = entry.calories !== null ? Math.round(entry.calories) : null;

      await db
        .insert(foodEntry)
        .values({
          providerId: CRONOMETER_PROVIDER_ID,
          userId: effectiveUserId,
          externalId,
          date: entry.date,
          meal: entry.meal,
          foodName: entry.foodName,
          numberOfUnits: entry.amount,
          servingUnit: entry.unit,
          // Macros
          calories: caloriesInt,
          proteinG: entry.proteinG,
          carbsG: entry.carbsG,
          fatG: entry.fatG,
          fiberG: entry.fiberG,
          // Fat breakdown
          saturatedFatG: entry.saturatedFatG,
          polyunsaturatedFatG: entry.polyunsaturatedFatG,
          monounsaturatedFatG: entry.monounsaturatedFatG,
          transFatG: entry.transFatG,
          // Other
          cholesterolMg: entry.cholesterolMg,
          sodiumMg: entry.sodiumMg,
          potassiumMg: entry.potassiumMg,
          sugarG: entry.sugarG,
          // Vitamins
          vitaminAMcg: entry.vitaminAMcg,
          vitaminCMg: entry.vitaminCMg,
          vitaminDMcg: entry.vitaminDMcg,
          vitaminEMg: entry.vitaminEMg,
          vitaminKMcg: entry.vitaminKMcg,
          vitaminB1Mg: entry.vitaminB1Mg,
          vitaminB2Mg: entry.vitaminB2Mg,
          vitaminB3Mg: entry.vitaminB3Mg,
          vitaminB5Mg: entry.vitaminB5Mg,
          vitaminB6Mg: entry.vitaminB6Mg,
          vitaminB7Mcg: entry.vitaminB7Mcg,
          vitaminB9Mcg: entry.vitaminB9Mcg,
          vitaminB12Mcg: entry.vitaminB12Mcg,
          // Minerals
          calciumMg: entry.calciumMg,
          ironMg: entry.ironMg,
          magnesiumMg: entry.magnesiumMg,
          zincMg: entry.zincMg,
          seleniumMcg: entry.seleniumMcg,
          copperMg: entry.copperMg,
          manganeseMg: entry.manganeseMg,
          chromiumMcg: entry.chromiumMcg,
          iodineMcg: entry.iodineMcg,
          // Fatty acids
          omega3Mg: entry.omega3Mg,
          omega6Mg: entry.omega6Mg,
        })
        .onConflictDoUpdate({
          target: [foodEntry.providerId, foodEntry.externalId],
          set: {
            date: entry.date,
            meal: entry.meal,
            foodName: entry.foodName,
            numberOfUnits: entry.amount,
            servingUnit: entry.unit,
            calories: caloriesInt,
            proteinG: entry.proteinG,
            carbsG: entry.carbsG,
            fatG: entry.fatG,
            fiberG: entry.fiberG,
            saturatedFatG: entry.saturatedFatG,
            polyunsaturatedFatG: entry.polyunsaturatedFatG,
            monounsaturatedFatG: entry.monounsaturatedFatG,
            transFatG: entry.transFatG,
            cholesterolMg: entry.cholesterolMg,
            sodiumMg: entry.sodiumMg,
            potassiumMg: entry.potassiumMg,
            sugarG: entry.sugarG,
            vitaminAMcg: entry.vitaminAMcg,
            vitaminCMg: entry.vitaminCMg,
            vitaminDMcg: entry.vitaminDMcg,
            vitaminEMg: entry.vitaminEMg,
            vitaminKMcg: entry.vitaminKMcg,
            vitaminB1Mg: entry.vitaminB1Mg,
            vitaminB2Mg: entry.vitaminB2Mg,
            vitaminB3Mg: entry.vitaminB3Mg,
            vitaminB5Mg: entry.vitaminB5Mg,
            vitaminB6Mg: entry.vitaminB6Mg,
            vitaminB7Mcg: entry.vitaminB7Mcg,
            vitaminB9Mcg: entry.vitaminB9Mcg,
            vitaminB12Mcg: entry.vitaminB12Mcg,
            calciumMg: entry.calciumMg,
            ironMg: entry.ironMg,
            magnesiumMg: entry.magnesiumMg,
            zincMg: entry.zincMg,
            seleniumMcg: entry.seleniumMcg,
            copperMg: entry.copperMg,
            manganeseMg: entry.manganeseMg,
            chromiumMcg: entry.chromiumMcg,
            iodineMcg: entry.iodineMcg,
            omega3Mg: entry.omega3Mg,
            omega6Mg: entry.omega6Mg,
          },
        });

      recordsSynced++;

      // Accumulate daily totals
      const dayKey = entry.date;
      const existing = dailyAggregates.get(dayKey) ?? {
        calories: 0,
        proteinG: 0,
        carbsG: 0,
        fatG: 0,
        fiberG: 0,
      };
      existing.calories += entry.calories ?? 0;
      existing.proteinG += entry.proteinG ?? 0;
      existing.carbsG += entry.carbsG ?? 0;
      existing.fatG += entry.fatG ?? 0;
      existing.fiberG += entry.fiberG ?? 0;
      dailyAggregates.set(dayKey, existing);
    } catch (err) {
      errors.push({
        message: `Failed to import "${entry.foodName}" on ${entry.date}: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }
  }

  // Upsert daily nutrition aggregates
  for (const [dateStr, totals] of dailyAggregates) {
    try {
      await db
        .insert(nutritionDaily)
        .values({
          date: dateStr,
          providerId: CRONOMETER_PROVIDER_ID,
          userId: effectiveUserId,
          calories: Math.round(totals.calories),
          proteinG: totals.proteinG,
          carbsG: totals.carbsG,
          fatG: totals.fatG,
          fiberG: totals.fiberG,
        })
        .onConflictDoUpdate({
          target: [nutritionDaily.date, nutritionDaily.providerId],
          set: {
            calories: Math.round(totals.calories),
            proteinG: totals.proteinG,
            carbsG: totals.carbsG,
            fatG: totals.fatG,
            fiberG: totals.fiberG,
          },
        });
    } catch (err) {
      errors.push({
        message: `Failed to upsert daily nutrition for ${dateStr}: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }
  }

  return { provider: CRONOMETER_PROVIDER_ID, recordsSynced, errors, duration: Date.now() - start };
}

// ============================================================
// Provider (stub — real import happens via upload endpoint)
// ============================================================

export class CronometerCsvProvider implements ImportProvider {
  readonly id = CRONOMETER_PROVIDER_ID;
  readonly name = "Cronometer";
  readonly importOnly = true as const;

  validate(): string | null {
    return null; // Always valid — file import, no API key needed
  }
}
