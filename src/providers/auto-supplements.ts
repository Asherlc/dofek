import { asc } from "drizzle-orm";
import type { SyncDatabase } from "../db/index.ts";
import { foodEntry, supplement } from "../db/schema.ts";
import { ensureProvider } from "../db/tokens.ts";
import type { Provider, SyncError, SyncResult } from "./types.ts";

// ============================================================
// Entry builder
// ============================================================

/** Slugify a supplement name for use in externalId */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

/** Nutrient keys shared between supplement table and food_entry schema */
const NUTRIENT_KEYS = [
  "calories",
  "proteinG",
  "carbsG",
  "fatG",
  "saturatedFatG",
  "polyunsaturatedFatG",
  "monounsaturatedFatG",
  "transFatG",
  "cholesterolMg",
  "sodiumMg",
  "potassiumMg",
  "fiberG",
  "sugarG",
  "vitaminAMcg",
  "vitaminCMg",
  "vitaminDMcg",
  "vitaminEMg",
  "vitaminKMcg",
  "vitaminB1Mg",
  "vitaminB2Mg",
  "vitaminB3Mg",
  "vitaminB5Mg",
  "vitaminB6Mg",
  "vitaminB7Mcg",
  "vitaminB9Mcg",
  "vitaminB12Mcg",
  "calciumMg",
  "ironMg",
  "magnesiumMg",
  "zincMg",
  "seleniumMcg",
  "copperMg",
  "manganeseMg",
  "chromiumMcg",
  "iodineMcg",
  "omega3Mg",
  "omega6Mg",
] as const;

type SupplementRow = typeof supplement.$inferSelect;

const mealValues = ["breakfast", "lunch", "dinner", "snack", "other"] as const;

export interface DailySupplementEntry {
  providerId: string;
  externalId: string;
  userId: string;
  date: string;
  meal: (typeof mealValues)[number];
  foodName: string;
  foodDescription: string | null;
  category: "supplement";
  numberOfUnits: number;
  nutrients: Record<string, number | null>;
}

/**
 * Build food_entry rows for each supplement × each date.
 */
export function buildDailyEntries(
  supplements: SupplementRow[],
  dates: string[],
): DailySupplementEntry[] {
  const entries: DailySupplementEntry[] = [];

  for (const date of dates) {
    for (const supp of supplements) {
      const nutrients: Record<string, number | null> = Object.fromEntries(
        NUTRIENT_KEYS.map((key) => [key, supp[key] ?? null]),
      );
      entries.push({
        providerId: "auto-supplements",
        externalId: `auto:${slugify(supp.name)}:${supp.userId}:${date}`,
        userId: supp.userId,
        date,
        meal: supp.meal ?? "other",
        foodName: supp.name,
        foodDescription: supp.description,
        category: "supplement",
        numberOfUnits: 1,
        nutrients,
      });
    }
  }

  return entries;
}

// ============================================================
// Provider
// ============================================================

const PROVIDER_ID = "auto-supplements";
const PROVIDER_NAME = "Auto-Supplements";

/** Generate ISO date strings for each day in the range [since, today]. */
function datesInRange(since: Date): string[] {
  const dates: string[] = [];
  const now = new Date();
  const current = new Date(since);
  // Start from the date portion
  current.setUTCHours(0, 0, 0, 0);

  while (current <= now) {
    dates.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }

  return dates;
}

export class AutoSupplementsProvider implements Provider {
  readonly id = PROVIDER_ID;
  readonly name = PROVIDER_NAME;

  validate(): string | null {
    // Always valid — supplements are stored in the DB per-user
    return null;
  }

  async sync(db: SyncDatabase, since: Date): Promise<SyncResult> {
    const start = Date.now();
    const errors: SyncError[] = [];

    // Query all users' supplements from the DB
    const allSupplements = await db
      .select()
      .from(supplement)
      .orderBy(asc(supplement.userId), asc(supplement.sortOrder));

    if (allSupplements.length === 0) {
      return { provider: PROVIDER_ID, recordsSynced: 0, errors, duration: Date.now() - start };
    }

    const dates = datesInRange(since);
    if (dates.length === 0) {
      return { provider: PROVIDER_ID, recordsSynced: 0, errors, duration: Date.now() - start };
    }

    await ensureProvider(db, PROVIDER_ID, PROVIDER_NAME);
    const entries = buildDailyEntries(allSupplements, dates);

    let synced = 0;
    for (const entry of entries) {
      try {
        await db
          .insert(foodEntry)
          .values({
            providerId: entry.providerId,
            externalId: entry.externalId,
            userId: entry.userId,
            date: entry.date,
            meal: entry.meal,
            foodName: entry.foodName,
            foodDescription: entry.foodDescription,
            category: "supplement",
            numberOfUnits: entry.numberOfUnits,
            ...entry.nutrients,
          })
          .onConflictDoUpdate({
            target: [foodEntry.providerId, foodEntry.externalId],
            set: {
              foodName: entry.foodName,
              foodDescription: entry.foodDescription,
              ...entry.nutrients,
            },
          });
        synced++;
      } catch (e) {
        errors.push({
          message: `Failed to upsert ${entry.foodName} for ${entry.date}: ${e instanceof Error ? e.message : String(e)}`,
          externalId: entry.externalId,
          cause: e,
        });
      }
    }

    return { provider: PROVIDER_ID, recordsSynced: synced, errors, duration: Date.now() - start };
  }
}
