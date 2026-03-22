import {
  NUTRIENT_COLUMN_MAP,
  NUTRIENT_SQL_COLUMNS,
  nutrientFieldsSchema,
  nutrientRowSchema,
} from "dofek/db/nutrient-columns";
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

const createFoodEntrySchema = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD format"),
    meal: z.enum(mealValues).nullish(),
    foodName: z.string().min(1).max(500),
    foodDescription: z.string().max(2000).nullish(),
    category: z.enum(foodCategoryValues).nullish(),
    numberOfUnits: z.number().positive().nullish(),
  })
  .merge(nutrientFieldsSchema);

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
  })
  .merge(nutrientFieldsSchema.partial());

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

/** Map of camelCase field names to SQL column names (food_entry-specific + nutrients) */
const fieldColumnMap: Record<string, string> = {
  date: "date",
  meal: "meal",
  foodName: "food_name",
  foodDescription: "food_description",
  category: "category",
  numberOfUnits: "number_of_units",
};

/** Zod schema for v_food_entry_with_nutrition rows */
const foodEntryRowSchema = z
  .object({
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
    nutrition_data_id: z.string().nullable(),
    raw: z.unknown().nullable(),
    confirmed: z.boolean(),
    created_at: z.string(),
  })
  .merge(nutrientRowSchema);

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
      if (input.meal) {
        const rows = await executeWithSchema(
          ctx.db,
          foodEntryRowSchema,
          sql`SELECT * FROM fitness.v_food_entry_with_nutrition
              WHERE user_id = ${ctx.userId}
                AND confirmed = true
                AND date >= ${input.startDate}::date
                AND date <= ${input.endDate}::date
                AND meal = ${input.meal}
              ORDER BY date ASC, meal ASC, food_name ASC`,
        );
        return rows;
      }
      const rows = await executeWithSchema(
        ctx.db,
        foodEntryRowSchema,
        sql`SELECT * FROM fitness.v_food_entry_with_nutrition
            WHERE user_id = ${ctx.userId}
              AND confirmed = true
              AND date >= ${input.startDate}::date
              AND date <= ${input.endDate}::date
            ORDER BY date ASC, meal ASC, food_name ASC`,
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
        sql`SELECT * FROM fitness.v_food_entry_with_nutrition
            WHERE user_id = ${ctx.userId}
              AND confirmed = true
              AND date = ${input.date}::date
            ORDER BY meal ASC, food_name ASC`,
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
              fe.date,
              SUM(nd.calories) as calories,
              SUM(nd.protein_g)::numeric(10,1) as protein_g,
              SUM(nd.carbs_g)::numeric(10,1) as carbs_g,
              SUM(nd.fat_g)::numeric(10,1) as fat_g,
              SUM(nd.fiber_g)::numeric(10,1) as fiber_g
            FROM fitness.food_entry fe
            JOIN fitness.nutrition_data nd ON fe.nutrition_data_id = nd.id
            WHERE fe.user_id = ${ctx.userId}
              AND fe.confirmed = true
              AND fe.date > CURRENT_DATE - ${input.days}::int
            GROUP BY fe.date
            ORDER BY fe.date ASC`,
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
        sql`SELECT DISTINCT ON (fe.food_name)
              fe.food_name, fe.food_description, fe.category,
              nd.calories, nd.protein_g, nd.carbs_g, nd.fat_g, nd.fiber_g,
              fe.number_of_units
            FROM fitness.food_entry fe
            LEFT JOIN fitness.nutrition_data nd ON fe.nutrition_data_id = nd.id
            WHERE fe.user_id = ${ctx.userId}
              AND fe.confirmed = true
              AND fe.food_name ILIKE ${searchPattern}
            ORDER BY fe.food_name ASC
            LIMIT ${input.limit}`,
      );
      return rows;
    }),

  /** Create a new food entry */
  create: protectedProcedure.input(createFoodEntrySchema).mutation(async ({ ctx, input }) => {
    await ensureDofekProvider(ctx.db);

    // Insert nutrition_data + food_entry in a CTE, return the new entry ID
    const idRows = await executeWithSchema(
      ctx.db,
      z.object({ id: z.string() }),
      sql`WITH new_nutrition AS (
            INSERT INTO fitness.nutrition_data (
              ${sql.raw(NUTRIENT_SQL_COLUMNS)}
            ) VALUES (
              ${input.calories ?? null}, ${input.proteinG ?? null},
              ${input.carbsG ?? null}, ${input.fatG ?? null},
              ${input.saturatedFatG ?? null}, ${input.polyunsaturatedFatG ?? null},
              ${input.monounsaturatedFatG ?? null}, ${input.transFatG ?? null},
              ${input.cholesterolMg ?? null}, ${input.sodiumMg ?? null},
              ${input.potassiumMg ?? null}, ${input.fiberG ?? null}, ${input.sugarG ?? null},
              ${input.vitaminAMcg ?? null}, ${input.vitaminCMg ?? null},
              ${input.vitaminDMcg ?? null}, ${input.vitaminEMg ?? null},
              ${input.vitaminKMcg ?? null},
              ${input.vitaminB1Mg ?? null}, ${input.vitaminB2Mg ?? null},
              ${input.vitaminB3Mg ?? null}, ${input.vitaminB5Mg ?? null},
              ${input.vitaminB6Mg ?? null},
              ${input.vitaminB7Mcg ?? null}, ${input.vitaminB9Mcg ?? null},
              ${input.vitaminB12Mcg ?? null},
              ${input.calciumMg ?? null}, ${input.ironMg ?? null},
              ${input.magnesiumMg ?? null}, ${input.zincMg ?? null},
              ${input.seleniumMcg ?? null},
              ${input.copperMg ?? null}, ${input.manganeseMg ?? null},
              ${input.chromiumMcg ?? null}, ${input.iodineMcg ?? null},
              ${input.omega3Mg ?? null}, ${input.omega6Mg ?? null}
            ) RETURNING id
          )
          INSERT INTO fitness.food_entry (
            user_id, provider_id, date, meal, food_name, food_description,
            category, number_of_units, nutrition_data_id
          ) VALUES (
            ${ctx.userId}, ${DOFEK_PROVIDER_ID}, ${input.date}::date,
            ${input.meal ?? null}, ${input.foodName}, ${input.foodDescription ?? null},
            ${input.category ?? null}, ${input.numberOfUnits ?? null},
            (SELECT id FROM new_nutrition)
          ) RETURNING id`,
    );
    const newId = idRows[0]?.id;

    // Fetch the full row from the view (separate query so the view can see the committed data)
    const rows = await executeWithSchema(
      ctx.db,
      foodEntryRowSchema,
      sql`SELECT * FROM fitness.v_food_entry_with_nutrition WHERE id = ${newId}`,
    );
    return rows[0];
  }),

  /** Update an existing food entry by id */
  update: protectedProcedure.input(updateFoodEntrySchema).mutation(async ({ ctx, input }) => {
    const { id, ...fields } = input;

    // Separate food_entry fields from nutrient fields
    const foodEntryClauses: ReturnType<typeof sql>[] = [];
    const nutrientClauses: ReturnType<typeof sql>[] = [];

    for (const [fieldName, value] of Object.entries(fields)) {
      if (value === undefined) continue;

      // Check if it's a food_entry field
      const foodColumn = fieldColumnMap[fieldName];
      if (foodColumn) {
        if (fieldName === "date") {
          foodEntryClauses.push(
            value !== null
              ? sql`${sql.identifier(foodColumn)} = ${String(value)}::date`
              : sql`${sql.identifier(foodColumn)} = NULL`,
          );
        } else if (value === null) {
          foodEntryClauses.push(sql`${sql.identifier(foodColumn)} = NULL`);
        } else {
          foodEntryClauses.push(sql`${sql.identifier(foodColumn)} = ${value}`);
        }
        continue;
      }

      // Check if it's a nutrient field
      const nutrientColumn = NUTRIENT_COLUMN_MAP[fieldName];
      if (nutrientColumn) {
        if (value === null) {
          nutrientClauses.push(sql`${sql.identifier(nutrientColumn)} = NULL`);
        } else {
          nutrientClauses.push(sql`${sql.identifier(nutrientColumn)} = ${value}`);
        }
      }
    }

    if (foodEntryClauses.length === 0 && nutrientClauses.length === 0) return null;

    // Update nutrition_data if any nutrient fields changed
    if (nutrientClauses.length > 0) {
      const nutrientSetExpression = sql.join(nutrientClauses, sql`, `);
      await ctx.db.execute(
        sql`UPDATE fitness.nutrition_data SET ${nutrientSetExpression}
            WHERE id = (SELECT nutrition_data_id FROM fitness.food_entry WHERE user_id = ${ctx.userId} AND confirmed = true AND id = ${id})`,
      );
    }

    // Update food_entry if any food fields changed
    if (foodEntryClauses.length > 0) {
      const foodSetExpression = sql.join(foodEntryClauses, sql`, `);
      await ctx.db.execute(
        sql`UPDATE fitness.food_entry SET ${foodSetExpression} WHERE user_id = ${ctx.userId} AND confirmed = true AND id = ${id}`,
      );
    }

    // Return the updated row from the view
    const rows = await executeWithSchema(
      ctx.db,
      foodEntryRowSchema,
      sql`SELECT * FROM fitness.v_food_entry_with_nutrition WHERE id = ${id}`,
    );
    return rows[0] ?? null;
  }),

  /** Delete a food entry by id */
  delete: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      // Delete food_entry (nutrition_data row remains orphaned but harmless,
      // or we can cascade — for now, delete both)
      await ctx.db.execute(
        sql`WITH deleted_entry AS (
              DELETE FROM fitness.food_entry
              WHERE user_id = ${ctx.userId} AND confirmed = true AND id = ${input.id}
              RETURNING nutrition_data_id
            )
            DELETE FROM fitness.nutrition_data
            WHERE id = (SELECT nutrition_data_id FROM deleted_entry)`,
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

      const idRows = await executeWithSchema(
        ctx.db,
        z.object({ id: z.string() }),
        sql`WITH new_nutrition AS (
              INSERT INTO fitness.nutrition_data (calories, protein_g, carbs_g, fat_g)
              VALUES (${input.calories}, ${input.proteinG ?? null},
                      ${input.carbsG ?? null}, ${input.fatG ?? null})
              RETURNING id
            )
            INSERT INTO fitness.food_entry (
              user_id, provider_id, date, meal, food_name, nutrition_data_id
            ) VALUES (
              ${ctx.userId}, ${DOFEK_PROVIDER_ID}, ${input.date}::date,
              ${input.meal}, ${input.foodName},
              (SELECT id FROM new_nutrition)
            ) RETURNING id`,
      );
      const newId = idRows[0]?.id;

      const rows = await executeWithSchema(
        ctx.db,
        foodEntryRowSchema,
        sql`SELECT * FROM fitness.v_food_entry_with_nutrition WHERE id = ${newId}`,
      );
      return rows[0];
    }),
});
