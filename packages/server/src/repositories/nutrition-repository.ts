import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { dateStringSchema, executeWithSchema } from "../lib/typed-sql.ts";

// ---------------------------------------------------------------------------
// Domain model
// ---------------------------------------------------------------------------

export interface NutritionDayRow {
  date: string;
  providerId: string;
  userId: string;
  calories: number | null;
  proteinGrams: number | null;
  carbsGrams: number | null;
  fatGrams: number | null;
  fiberGrams: number | null;
  waterMl: number | null;
  createdAt: string;
}

/** A single day's nutrition totals from a specific provider. */
export class NutritionDay {
  readonly #row: NutritionDayRow;

  constructor(row: NutritionDayRow) {
    this.#row = row;
  }

  get date(): string {
    return this.#row.date;
  }

  get providerId(): string {
    return this.#row.providerId;
  }

  get calories(): number | null {
    return this.#row.calories;
  }

  toDetail() {
    return {
      date: this.#row.date,
      provider_id: this.#row.providerId,
      user_id: this.#row.userId,
      calories: this.#row.calories,
      protein_g: this.#row.proteinGrams,
      carbs_g: this.#row.carbsGrams,
      fat_g: this.#row.fatGrams,
      fiber_g: this.#row.fiberGrams,
      water_ml: this.#row.waterMl,
      created_at: this.#row.createdAt,
    };
  }
}

// ---------------------------------------------------------------------------
// Zod schema for raw DB rows
// ---------------------------------------------------------------------------

const nutritionDailyDbSchema = z.object({
  date: dateStringSchema,
  provider_id: z.string(),
  user_id: z.string(),
  calories: z.coerce.number().nullable(),
  protein_g: z.coerce.number().nullable(),
  carbs_g: z.coerce.number().nullable(),
  fat_g: z.coerce.number().nullable(),
  fiber_g: z.coerce.number().nullable(),
  water_ml: z.coerce.number().nullable(),
  created_at: z.string(),
});

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

/** Data access for daily nutrition logs. */
export class NutritionRepository {
  readonly #db: Pick<Database, "execute">;
  readonly #userId: string;
  constructor(db: Pick<Database, "execute">, userId: string, _timezone: string) {
    this.#db = db;
    this.#userId = userId;
  }

  /** Daily nutrition totals after the given start date, ordered ascending. */
  async getDailyNutrition(startDate: string): Promise<NutritionDay[]> {
    const rows = await executeWithSchema(
      this.#db,
      nutritionDailyDbSchema,
      sql`SELECT * FROM fitness.nutrition_daily
          WHERE user_id = ${this.#userId}
            AND date > ${startDate}::date
          ORDER BY date ASC`,
    );

    return rows.map(
      (row) =>
        new NutritionDay({
          date: String(row.date),
          providerId: row.provider_id,
          userId: row.user_id,
          calories: row.calories,
          proteinGrams: row.protein_g,
          carbsGrams: row.carbs_g,
          fatGrams: row.fat_g,
          fiberGrams: row.fiber_g,
          waterMl: row.water_ml,
          createdAt: row.created_at,
        }),
    );
  }
}
