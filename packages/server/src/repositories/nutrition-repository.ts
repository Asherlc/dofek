import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { dateStringSchema, executeWithSchema, timestampStringSchema } from "../lib/typed-sql.ts";

// ---------------------------------------------------------------------------
// Domain model
// ---------------------------------------------------------------------------

export interface NutritionDayRow {
  date: string;
  providerId: string | null;
  userId: string;
  calories: number | null;
  proteinGrams: number | null;
  carbsGrams: number | null;
  fatGrams: number | null;
  fiberGrams: number | null;
  waterMl: number | null;
  createdAt: string | null;
  resolutionStatus: "available" | "source_conflict";
  resolutionMessage: string;
  sourceProviders: string[];
  contributingProviders: string[];
  excludedProviders: string[];
}

/** A single day's canonical nutrition totals and source resolution. */
export class NutritionDay {
  readonly #row: NutritionDayRow;

  constructor(row: NutritionDayRow) {
    this.#row = row;
  }

  get date(): string {
    return this.#row.date;
  }

  get providerId(): string | null {
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
      resolution_status: this.#row.resolutionStatus,
      resolution_message: this.#row.resolutionMessage,
      source_providers: this.#row.sourceProviders,
      contributing_providers: this.#row.contributingProviders,
      excluded_providers: this.#row.excludedProviders,
    };
  }
}

// ---------------------------------------------------------------------------
// Zod schema for raw DB rows
// ---------------------------------------------------------------------------

const nutritionDailyDbSchema = z.object({
  date: dateStringSchema,
  provider_id: z.string().nullable(),
  user_id: z.string(),
  calories: z.coerce.number().nullable(),
  protein_g: z.coerce.number().nullable(),
  carbs_g: z.coerce.number().nullable(),
  fat_g: z.coerce.number().nullable(),
  fiber_g: z.coerce.number().nullable(),
  water_ml: z.coerce.number().nullable(),
  created_at: timestampStringSchema.nullable(),
  resolution_status: z.enum(["available", "source_conflict"]),
  resolution_message: z.string(),
  source_providers: z.array(z.string()),
  contributing_providers: z.array(z.string()),
  excluded_providers: z.array(z.string()),
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
      sql`SELECT
            date,
            CASE
              WHEN CARDINALITY(contributing_providers) = 1 THEN contributing_providers[1]
              ELSE NULL
            END AS provider_id,
            user_id,
            calories,
            protein_g,
            carbs_g,
            fat_g,
            fiber_g,
            water_ml,
            created_at,
            resolution_status,
            resolution_message,
            source_providers,
            contributing_providers,
            excluded_providers
          FROM fitness.v_nutrition_daily
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
          resolutionStatus: row.resolution_status,
          resolutionMessage: row.resolution_message,
          sourceProviders: row.source_providers,
          contributingProviders: row.contributing_providers,
          excludedProviders: row.excluded_providers,
        }),
    );
  }
}
