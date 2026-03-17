import { z } from "zod";
import type { SyncDatabase } from "../db/index.ts";
import { foodEntry } from "../db/schema.ts";
import { ensureProvider } from "../db/tokens.ts";
import type { Provider, SyncError, SyncResult } from "./types.ts";

// ============================================================
// Supplement config types & validation
// ============================================================

const mealValues = ["breakfast", "lunch", "dinner", "snack", "other"] as const;

const supplementDefinitionSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  meal: z.enum(mealValues).optional(),
  // Macronutrients
  calories: z.number().optional(),
  proteinG: z.number().optional(),
  carbsG: z.number().optional(),
  fatG: z.number().optional(),
  // Fat breakdown
  saturatedFatG: z.number().optional(),
  polyunsaturatedFatG: z.number().optional(),
  monounsaturatedFatG: z.number().optional(),
  transFatG: z.number().optional(),
  // Other macros
  cholesterolMg: z.number().optional(),
  sodiumMg: z.number().optional(),
  potassiumMg: z.number().optional(),
  fiberG: z.number().optional(),
  sugarG: z.number().optional(),
  // Micronutrients
  vitaminAMcg: z.number().optional(),
  vitaminCMg: z.number().optional(),
  vitaminDMcg: z.number().optional(),
  vitaminEMg: z.number().optional(),
  vitaminKMcg: z.number().optional(),
  vitaminB1Mg: z.number().optional(),
  vitaminB2Mg: z.number().optional(),
  vitaminB3Mg: z.number().optional(),
  vitaminB5Mg: z.number().optional(),
  vitaminB6Mg: z.number().optional(),
  vitaminB7Mcg: z.number().optional(),
  vitaminB9Mcg: z.number().optional(),
  vitaminB12Mcg: z.number().optional(),
  calciumMg: z.number().optional(),
  ironMg: z.number().optional(),
  magnesiumMg: z.number().optional(),
  zincMg: z.number().optional(),
  seleniumMcg: z.number().optional(),
  copperMg: z.number().optional(),
  manganeseMg: z.number().optional(),
  chromiumMcg: z.number().optional(),
  iodineMcg: z.number().optional(),
  omega3Mg: z.number().optional(),
  omega6Mg: z.number().optional(),
  // Supplement-specific metadata
  amount: z.number().optional(),
  unit: z.string().optional(),
  form: z.string().optional(),
});

export const supplementConfigSchema = z.object({
  supplements: z.array(supplementDefinitionSchema).min(1),
});

export type SupplementDefinition = z.infer<typeof supplementDefinitionSchema>;
export type SupplementConfig = z.infer<typeof supplementConfigSchema>;

export function parseSupplementConfig(raw: unknown): SupplementDefinition[] {
  const config = supplementConfigSchema.parse(raw);
  return config.supplements;
}

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

/** Nutrient keys shared between SupplementDefinition and food_entry schema */
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

export interface DailySupplementEntry {
  providerId: string;
  externalId: string;
  date: string;
  meal: (typeof mealValues)[number];
  foodName: string;
  foodDescription: string | undefined;
  category: "supplement";
  numberOfUnits: number;
  nutrients: Partial<Record<(typeof NUTRIENT_KEYS)[number], number>>;
}

/**
 * Build food_entry rows for each supplement × each date.
 */
export function buildDailyEntries(
  supplements: SupplementDefinition[],
  dates: string[],
): DailySupplementEntry[] {
  const entries: DailySupplementEntry[] = [];

  for (const date of dates) {
    for (const supp of supplements) {
      const nutrients: DailySupplementEntry["nutrients"] = {};
      for (const key of NUTRIENT_KEYS) {
        if (supp[key] != null) nutrients[key] = supp[key];
      }
      entries.push({
        providerId: "auto-supplements",
        externalId: `auto:${slugify(supp.name)}:${date}`,
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

  private config: SupplementConfig | null = null;

  constructor(config?: SupplementConfig) {
    if (config) {
      this.config = config;
    }
  }

  validate(): string | null {
    if (!this.config) {
      return "No supplement config provided. Create supplements.config.ts with your supplement stack.";
    }
    try {
      parseSupplementConfig(this.config);
      return null;
    } catch (e) {
      return `Invalid supplement config: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  async sync(db: SyncDatabase, since: Date): Promise<SyncResult> {
    const start = Date.now();
    const errors: SyncError[] = [];

    if (!this.config) {
      return {
        provider: PROVIDER_ID,
        recordsSynced: 0,
        errors: [{ message: "No supplement config" }],
        duration: Date.now() - start,
      };
    }

    const supplements = parseSupplementConfig(this.config);
    const dates = datesInRange(since);

    if (dates.length === 0) {
      return { provider: PROVIDER_ID, recordsSynced: 0, errors, duration: Date.now() - start };
    }

    await ensureProvider(db, PROVIDER_ID, PROVIDER_NAME);
    const entries = buildDailyEntries(supplements, dates);

    let synced = 0;
    for (const entry of entries) {
      try {
        await db
          .insert(foodEntry)
          .values({
            providerId: entry.providerId,
            externalId: entry.externalId,
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
