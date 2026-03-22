import { sql } from "drizzle-orm";
import { z } from "zod";
import { analyzeNutrition } from "../lib/ai-nutrition.ts";
import { executeWithSchema } from "../lib/typed-sql.ts";
import { logger } from "../logger.ts";
import { CacheTTL, cachedProtectedQuery, protectedProcedure, router } from "../trpc.ts";

const mealValues = ["breakfast", "lunch", "dinner", "snack", "other"] as const;

const foodCategoryValues = [
  "beans_and_legumes",
  "beverages",
  "breads_and_cereals",
  "cheese_milk_and_dairy",
  "eggs",
  "fast_food",
  "fish_and_seafood",
  "fruit",
  "meat",
  "nuts_and_seeds",
  "pasta_rice_and_noodles",
  "salads",
  "sauces_spices_and_spreads",
  "snacks",
  "soups",
  "sweets_candy_and_desserts",
  "vegetables",
  "supplement",
  "other",
] as const;

/** Shared schema for macronutrient fields (all optional numbers) */
const macroFieldsSchema = z.object({
  calories: z.number().int().nonnegative().nullish(),
  proteinG: z.number().nonnegative().nullish(),
  carbsG: z.number().nonnegative().nullish(),
  fatG: z.number().nonnegative().nullish(),
  fiberG: z.number().nonnegative().nullish(),
});

/** Schema for the normalized nutrients map (nutrient_id → amount) */
const nutrientsMapSchema = z.record(z.string(), z.number().nonnegative()).default({});

const createFoodEntrySchema = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD format"),
    meal: z.enum(mealValues).nullish(),
    foodName: z.string().min(1).max(500),
    foodDescription: z.string().max(2000).nullish(),
    category: z.enum(foodCategoryValues).nullish(),
    numberOfUnits: z.number().positive().nullish(),
    nutrients: nutrientsMapSchema,
  })
  .merge(macroFieldsSchema);

const updateFoodEntrySchema = z
  .object({
    id: z.string().uuid(),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD format")
      .optional(),
    meal: z.enum(mealValues).nullish(),
    foodName: z.string().min(1).max(500).optional(),
    foodDescription: z.string().max(2000).nullish(),
    category: z.enum(foodCategoryValues).nullish(),
    numberOfUnits: z.number().positive().nullish(),
    nutrients: nutrientsMapSchema.optional(),
  })
  .merge(macroFieldsSchema.partial());

const DOFEK_PROVIDER_ID = "dofek";

/** Ensure the 'dofek' provider row exists (for self-created entries) */
async function ensureDofekProvider(
  db: Parameters<Parameters<typeof protectedProcedure.mutation>[0]>[0]["ctx"]["db"],
) {
  await db.execute(
    sql`INSERT INTO fitness.provider (id, name)
        VALUES (${DOFEK_PROVIDER_ID}, 'Dofek App')
        ON CONFLICT (id) DO NOTHING`,
  );
}

/** Map of camelCase field names to SQL column names (structural + macros only) */
const fieldColumnMap: Record<string, string> = {
  date: "date",
  meal: "meal",
  foodName: "food_name",
  foodDescription: "food_description",
  category: "category",
  numberOfUnits: "number_of_units",
  calories: "calories",
  proteinG: "protein_g",
  carbsG: "carbs_g",
  fatG: "fat_g",
  fiberG: "fiber_g",
};

/** Zod schema for food_entry rows with nutrients from junction table */
const foodEntryRowSchema = z.object({
  id: z.string(),
  provider_id: z.string(),
  user_id: z.string(),
  external_id: z.string().nullable(),
  date: z.string(),
  meal: z.string().nullable(),
  food_name: z.string(),
  food_description: z.string().nullable(),
  category: z.string().nullable(),
  provider_food_id: z.string().nullable(),
  provider_serving_id: z.string().nullable(),
  number_of_units: z.coerce.number().nullable(),
  logged_at: z.string().nullable(),
  barcode: z.string().nullable(),
  serving_unit: z.string().nullable(),
  serving_weight_grams: z.coerce.number().nullable(),
  calories: z.coerce.number().nullable(),
  protein_g: z.coerce.number().nullable(),
  carbs_g: z.coerce.number().nullable(),
  fat_g: z.coerce.number().nullable(),
  fiber_g: z.coerce.number().nullable(),
  raw: z.unknown().nullable(),
  confirmed: z.boolean(),
  created_at: z.string(),
  /** Nutrients from junction table, aggregated as JSON object { nutrient_id: amount } */
  nutrients: z.preprocess(
    (val) => (typeof val === "string" ? JSON.parse(val) : (val ?? {})),
    z.record(z.string(), z.number()).default({}),
  ),
});

/** Zod schema for food_entry rows from RETURNING * (no join, nutrients added separately) */
const foodEntryInsertRowSchema = z.object({
  id: z.string(),
  provider_id: z.string(),
  user_id: z.string(),
  date: z.string(),
  meal: z.string().nullable(),
  food_name: z.string(),
  food_description: z.string().nullable(),
  category: z.string().nullable(),
  calories: z.coerce.number().nullable(),
  protein_g: z.coerce.number().nullable(),
  carbs_g: z.coerce.number().nullable(),
  fat_g: z.coerce.number().nullable(),
  fiber_g: z.coerce.number().nullable(),
  confirmed: z.boolean(),
  created_at: z.string(),
});

const dailyTotalsRowSchema = z.object({
  date: z.string(),
  calories: z.coerce.number().nullable(),
  protein_g: z.coerce.number().nullable(),
  carbs_g: z.coerce.number().nullable(),
  fat_g: z.coerce.number().nullable(),
  fiber_g: z.coerce.number().nullable(),
});

const foodSearchRowSchema = z.object({
  food_name: z.string(),
  food_description: z.string().nullable(),
  category: z.string().nullable(),
  calories: z.coerce.number().nullable(),
  protein_g: z.coerce.number().nullable(),
  carbs_g: z.coerce.number().nullable(),
  fat_g: z.coerce.number().nullable(),
  fiber_g: z.coerce.number().nullable(),
  number_of_units: z.coerce.number().nullable(),
});

export const foodRouter = router({
  /** List food entries for a date range, optionally filtered by meal */
  list: cachedProtectedQuery(CacheTTL.SHORT)
    .input(
      z.object({
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        meal: z.enum(mealValues).optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const mealFilter = input.meal ? sql`AND fe.meal = ${input.meal}` : sql``;
      const rows = await executeWithSchema(
        ctx.db,
        foodEntryRowSchema,
        sql`SELECT fe.id, fe.provider_id, fe.user_id, fe.external_id, fe.date,
              fe.meal, fe.food_name, fe.food_description, fe.category,
              fe.provider_food_id, fe.provider_serving_id, fe.number_of_units,
              fe.logged_at, fe.barcode, fe.serving_unit, fe.serving_weight_grams,
              fe.calories, fe.protein_g, fe.carbs_g, fe.fat_g, fe.fiber_g,
              fe.raw, fe.confirmed, fe.created_at,
              COALESCE((SELECT json_object_agg(fen.nutrient_id, fen.amount)
                FROM fitness.food_entry_nutrient fen WHERE fen.food_entry_id = fe.id), '{}') AS nutrients
            FROM fitness.food_entry fe
            WHERE fe.user_id = ${ctx.userId}
              AND fe.confirmed = true
              AND fe.date >= ${input.startDate}::date
              AND fe.date <= ${input.endDate}::date
              ${mealFilter}
            ORDER BY fe.date ASC, fe.meal ASC, fe.food_name ASC`,
      );
      return rows;
    }),

  /** Get all food entries for a specific date, ordered by meal */
  byDate: cachedProtectedQuery(CacheTTL.SHORT)
    .input(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }))
    .query(async ({ ctx, input }) => {
      const rows = await executeWithSchema(
        ctx.db,
        foodEntryRowSchema,
        sql`SELECT fe.id, fe.provider_id, fe.user_id, fe.external_id, fe.date,
              fe.meal, fe.food_name, fe.food_description, fe.category,
              fe.provider_food_id, fe.provider_serving_id, fe.number_of_units,
              fe.logged_at, fe.barcode, fe.serving_unit, fe.serving_weight_grams,
              fe.calories, fe.protein_g, fe.carbs_g, fe.fat_g, fe.fiber_g,
              fe.raw, fe.confirmed, fe.created_at,
              COALESCE((SELECT json_object_agg(fen.nutrient_id, fen.amount)
                FROM fitness.food_entry_nutrient fen WHERE fen.food_entry_id = fe.id), '{}') AS nutrients
            FROM fitness.food_entry fe
            WHERE fe.user_id = ${ctx.userId}
              AND fe.confirmed = true
              AND fe.date = ${input.date}::date
            ORDER BY fe.meal ASC, fe.food_name ASC`,
      );
      if (rows.length === 0) {
        logger.info(`[food] byDate returned 0 rows for userId=${ctx.userId} date=${input.date}`);
      }
      return rows;
    }),

  /** Get daily calorie/macro totals aggregated by day */
  dailyTotals: cachedProtectedQuery(CacheTTL.SHORT)
    .input(z.object({ days: z.number().default(30) }))
    .query(async ({ ctx, input }) => {
      const rows = await executeWithSchema(
        ctx.db,
        dailyTotalsRowSchema,
        sql`SELECT
              date,
              SUM(calories) as calories,
              SUM(protein_g)::numeric(10,1) as protein_g,
              SUM(carbs_g)::numeric(10,1) as carbs_g,
              SUM(fat_g)::numeric(10,1) as fat_g,
              SUM(fiber_g)::numeric(10,1) as fiber_g
            FROM fitness.food_entry
            WHERE user_id = ${ctx.userId}
              AND confirmed = true
              AND date > CURRENT_DATE - ${input.days}::int
            GROUP BY date
            ORDER BY date ASC`,
      );
      return rows;
    }),

  /** Search food entries by name for quick re-logging */
  search: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(
      z.object({
        query: z.string().min(1).max(200),
        limit: z.number().int().positive().default(20),
      }),
    )
    .query(async ({ ctx, input }) => {
      const searchPattern = `%${input.query}%`;
      const rows = await executeWithSchema(
        ctx.db,
        foodSearchRowSchema,
        sql`SELECT DISTINCT ON (food_name)
              food_name, food_description, category, calories,
              protein_g, carbs_g, fat_g, fiber_g, number_of_units
            FROM fitness.food_entry
            WHERE user_id = ${ctx.userId}
              AND confirmed = true
              AND food_name ILIKE ${searchPattern}
            ORDER BY food_name ASC
            LIMIT ${input.limit}`,
      );
      return rows;
    }),

  /** Create a new food entry */
  create: protectedProcedure.input(createFoodEntrySchema).mutation(async ({ ctx, input }) => {
    await ensureDofekProvider(ctx.db);

    // Insert into food_entry (macros only)
    const rows = await executeWithSchema(
      ctx.db,
      foodEntryInsertRowSchema,
      sql`INSERT INTO fitness.food_entry (
            user_id, provider_id, date, meal, food_name, food_description,
            category, number_of_units,
            calories, protein_g, carbs_g, fat_g, fiber_g
          ) VALUES (
            ${ctx.userId}, ${DOFEK_PROVIDER_ID}, ${input.date}::date,
            ${input.meal ?? null}, ${input.foodName}, ${input.foodDescription ?? null},
            ${input.category ?? null}, ${input.numberOfUnits ?? null},
            ${input.calories ?? null}, ${input.proteinG ?? null},
            ${input.carbsG ?? null}, ${input.fatG ?? null}, ${input.fiberG ?? null}
          ) RETURNING *`,
    );
    const inserted = rows[0];
    if (!inserted) throw new Error("Failed to insert food entry");

    // Insert nutrients into junction table
    const nutrientEntries = Object.entries(input.nutrients);
    if (nutrientEntries.length > 0) {
      const valuesClauses = nutrientEntries.map(
        ([nutrientId, amount]) => sql`(${inserted.id}::uuid, ${nutrientId}, ${amount})`,
      );
      await ctx.db.execute(
        sql`INSERT INTO fitness.food_entry_nutrient (food_entry_id, nutrient_id, amount)
            VALUES ${sql.join(valuesClauses, sql`, `)}
            ON CONFLICT (food_entry_id, nutrient_id) DO UPDATE SET amount = EXCLUDED.amount`,
      );
    }

    return { ...inserted, nutrients: input.nutrients };
  }),

  /** Update an existing food entry by id */
  update: protectedProcedure.input(updateFoodEntrySchema).mutation(async ({ ctx, input }) => {
    const { id, nutrients, ...fields } = input;
    const setClauses: ReturnType<typeof sql>[] = [];

    for (const [fieldName, columnName] of Object.entries(fieldColumnMap)) {
      if (!Object.hasOwn(fields, fieldName)) continue;
      const fieldsRecord: Record<string, unknown> = fields;
      const value = fieldsRecord[fieldName];
      if (value !== undefined) {
        if (fieldName === "date") {
          setClauses.push(
            value !== null
              ? sql`${sql.identifier(columnName)} = ${String(value)}::date`
              : sql`${sql.identifier(columnName)} = NULL`,
          );
        } else if (value === null) {
          setClauses.push(sql`${sql.identifier(columnName)} = NULL`);
        } else {
          setClauses.push(sql`${sql.identifier(columnName)} = ${value}`);
        }
      }
    }

    if (setClauses.length > 0) {
      const setExpression = sql.join(setClauses, sql`, `);
      await ctx.db.execute(
        sql`UPDATE fitness.food_entry SET ${setExpression}
            WHERE user_id = ${ctx.userId} AND confirmed = true AND id = ${id}`,
      );
    }

    // Replace nutrients in junction table if provided
    if (nutrients) {
      await ctx.db.execute(
        sql`DELETE FROM fitness.food_entry_nutrient WHERE food_entry_id = ${id}::uuid`,
      );
      const nutrientEntries = Object.entries(nutrients);
      if (nutrientEntries.length > 0) {
        const valuesClauses = nutrientEntries.map(
          ([nutrientId, amount]) => sql`(${id}::uuid, ${nutrientId}, ${amount})`,
        );
        await ctx.db.execute(
          sql`INSERT INTO fitness.food_entry_nutrient (food_entry_id, nutrient_id, amount)
              VALUES ${sql.join(valuesClauses, sql`, `)}`,
        );
      }
    }

    // Re-fetch with nutrients
    const rows = await executeWithSchema(
      ctx.db,
      foodEntryRowSchema,
      sql`SELECT fe.*, COALESCE((SELECT json_object_agg(fen.nutrient_id, fen.amount)
            FROM fitness.food_entry_nutrient fen WHERE fen.food_entry_id = fe.id), '{}') AS nutrients
          FROM fitness.food_entry fe
          WHERE fe.user_id = ${ctx.userId} AND fe.confirmed = true AND fe.id = ${id}`,
    );
    return rows[0] ?? null;
  }),

  /** Delete a food entry by id */
  delete: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db.execute(
        sql`DELETE FROM fitness.food_entry WHERE user_id = ${ctx.userId} AND confirmed = true AND id = ${input.id}`,
      );
      return { success: true };
    }),

  /** Analyze a food description with AI and return estimated nutrition data */
  analyzeWithAi: protectedProcedure
    .input(z.object({ description: z.string().min(1).max(500) }))
    .mutation(async ({ input }) => {
      return analyzeNutrition(input.description);
    }),

  /** Quick-add a food entry with minimal details */
  quickAdd: protectedProcedure
    .input(
      z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        meal: z.enum(mealValues),
        foodName: z.string().min(1).max(500),
        calories: z.number().int().nonnegative(),
        proteinG: z.number().nonnegative().nullish(),
        carbsG: z.number().nonnegative().nullish(),
        fatG: z.number().nonnegative().nullish(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await ensureDofekProvider(ctx.db);

      const rows = await executeWithSchema(
        ctx.db,
        foodEntryInsertRowSchema,
        sql`INSERT INTO fitness.food_entry (
              user_id, provider_id, date, meal, food_name,
              calories, protein_g, carbs_g, fat_g
            ) VALUES (
              ${ctx.userId}, ${DOFEK_PROVIDER_ID}, ${input.date}::date,
              ${input.meal}, ${input.foodName},
              ${input.calories}, ${input.proteinG ?? null},
              ${input.carbsG ?? null}, ${input.fatG ?? null}
            ) RETURNING *`,
      );
      return rows[0] ? { ...rows[0], nutrients: {} } : undefined;
    }),
});
