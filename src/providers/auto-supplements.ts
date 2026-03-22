import { sql } from "drizzle-orm";
import type { SyncDatabase } from "../db/index.ts";
import { nutrientColumnsToValues } from "../db/nutrient-columns.ts";
import { foodEntry, nutritionData } from "../db/schema.ts";
import { ensureProvider } from "../db/tokens.ts";
import type { SyncError, SyncProvider, SyncResult } from "./types.ts";

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

/** A supplement row joined with its nutrition data from v_supplement_with_nutrition */
export interface SupplementWithNutrition {
  id: string;
  userId: string;
  user_id: string;
  name: string;
  amount: number | null;
  unit: string | null;
  form: string | null;
  description: string | null;
  meal: "breakfast" | "lunch" | "dinner" | "snack" | "other" | null;
  sort_order: number;
  nutrition_data_id: string | null;
  // Nutrient fields from the join (snake_case from view)
  calories: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  [key: string]: unknown;
}

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
  supplements: SupplementWithNutrition[],
  dates: string[],
): DailySupplementEntry[] {
  const entries: DailySupplementEntry[] = [];

  for (const date of dates) {
    for (const supp of supplements) {
      const nutrients = nutrientColumnsToValues(supp);
      entries.push({
        providerId: "auto-supplements",
        externalId: `auto:${slugify(supp.name)}:${supp.user_id}:${date}`,
        userId: supp.user_id,
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

export class AutoSupplementsProvider implements SyncProvider {
  readonly id = PROVIDER_ID;
  readonly name = PROVIDER_NAME;

  validate(): string | null {
    // Always valid — supplements are stored in the DB per-user
    return null;
  }

  async sync(db: SyncDatabase, since: Date): Promise<SyncResult> {
    const start = Date.now();
    const errors: SyncError[] = [];

    // Query all users' supplements with their nutrition data via the view
    const allSupplements = await db.execute<SupplementWithNutrition>(
      sql`SELECT * FROM fitness.v_supplement_with_nutrition ORDER BY user_id ASC, sort_order ASC`,
    );

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
        // Insert nutrition_data first
        const [ndRow] = await db
          .insert(nutritionData)
          .values(entry.nutrients)
          .returning({ id: nutritionData.id });

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
            nutritionDataId: ndRow?.id,
          })
          .onConflictDoUpdate({
            target: [foodEntry.providerId, foodEntry.externalId],
            set: {
              foodName: entry.foodName,
              foodDescription: entry.foodDescription,
              nutritionDataId: ndRow?.id,
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
