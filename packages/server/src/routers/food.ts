import { sql } from "drizzle-orm";
import { z } from "zod";
import { analyzeNutrition } from "../lib/ai-nutrition.ts";
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

/** Shared schema for nutritional fields (all optional numbers) */
const nutritionalFieldsSchema = z.object({
  calories: z.number().int().nonnegative().nullish(),
  proteinG: z.number().nonnegative().nullish(),
  carbsG: z.number().nonnegative().nullish(),
  fatG: z.number().nonnegative().nullish(),
  saturatedFatG: z.number().nonnegative().nullish(),
  polyunsaturatedFatG: z.number().nonnegative().nullish(),
  monounsaturatedFatG: z.number().nonnegative().nullish(),
  transFatG: z.number().nonnegative().nullish(),
  cholesterolMg: z.number().nonnegative().nullish(),
  sodiumMg: z.number().nonnegative().nullish(),
  potassiumMg: z.number().nonnegative().nullish(),
  fiberG: z.number().nonnegative().nullish(),
  sugarG: z.number().nonnegative().nullish(),
  vitaminAMcg: z.number().nonnegative().nullish(),
  vitaminCMg: z.number().nonnegative().nullish(),
  vitaminDMcg: z.number().nonnegative().nullish(),
  vitaminEMg: z.number().nonnegative().nullish(),
  vitaminKMcg: z.number().nonnegative().nullish(),
  vitaminB1Mg: z.number().nonnegative().nullish(),
  vitaminB2Mg: z.number().nonnegative().nullish(),
  vitaminB3Mg: z.number().nonnegative().nullish(),
  vitaminB5Mg: z.number().nonnegative().nullish(),
  vitaminB6Mg: z.number().nonnegative().nullish(),
  vitaminB7Mcg: z.number().nonnegative().nullish(),
  vitaminB9Mcg: z.number().nonnegative().nullish(),
  vitaminB12Mcg: z.number().nonnegative().nullish(),
  calciumMg: z.number().nonnegative().nullish(),
  ironMg: z.number().nonnegative().nullish(),
  magnesiumMg: z.number().nonnegative().nullish(),
  zincMg: z.number().nonnegative().nullish(),
  seleniumMcg: z.number().nonnegative().nullish(),
  copperMg: z.number().nonnegative().nullish(),
  manganeseMg: z.number().nonnegative().nullish(),
  chromiumMcg: z.number().nonnegative().nullish(),
  iodineMcg: z.number().nonnegative().nullish(),
  omega3Mg: z.number().nonnegative().nullish(),
  omega6Mg: z.number().nonnegative().nullish(),
});

const createFoodEntrySchema = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD format"),
    meal: z.enum(mealValues).nullish(),
    foodName: z.string().min(1),
    foodDescription: z.string().nullish(),
    category: z.enum(foodCategoryValues).nullish(),
    numberOfUnits: z.number().positive().nullish(),
  })
  .merge(nutritionalFieldsSchema);

const updateFoodEntrySchema = z
  .object({
    id: z.string().uuid(),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD format")
      .optional(),
    meal: z.enum(mealValues).nullish(),
    foodName: z.string().min(1).optional(),
    foodDescription: z.string().nullish(),
    category: z.enum(foodCategoryValues).nullish(),
    numberOfUnits: z.number().positive().nullish(),
  })
  .merge(nutritionalFieldsSchema.partial());

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

/** Map of camelCase field names to SQL column names */
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
  saturatedFatG: "saturated_fat_g",
  polyunsaturatedFatG: "polyunsaturated_fat_g",
  monounsaturatedFatG: "monounsaturated_fat_g",
  transFatG: "trans_fat_g",
  cholesterolMg: "cholesterol_mg",
  sodiumMg: "sodium_mg",
  potassiumMg: "potassium_mg",
  fiberG: "fiber_g",
  sugarG: "sugar_g",
  vitaminAMcg: "vitamin_a_mcg",
  vitaminCMg: "vitamin_c_mg",
  vitaminDMcg: "vitamin_d_mcg",
  vitaminEMg: "vitamin_e_mg",
  vitaminKMcg: "vitamin_k_mcg",
  vitaminB1Mg: "vitamin_b1_mg",
  vitaminB2Mg: "vitamin_b2_mg",
  vitaminB3Mg: "vitamin_b3_mg",
  vitaminB5Mg: "vitamin_b5_mg",
  vitaminB6Mg: "vitamin_b6_mg",
  vitaminB7Mcg: "vitamin_b7_mcg",
  vitaminB9Mcg: "vitamin_b9_mcg",
  vitaminB12Mcg: "vitamin_b12_mcg",
  calciumMg: "calcium_mg",
  ironMg: "iron_mg",
  magnesiumMg: "magnesium_mg",
  zincMg: "zinc_mg",
  seleniumMcg: "selenium_mcg",
  copperMg: "copper_mg",
  manganeseMg: "manganese_mg",
  chromiumMcg: "chromium_mcg",
  iodineMcg: "iodine_mcg",
  omega3Mg: "omega3_mg",
  omega6Mg: "omega6_mg",
};

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
        const rows = await ctx.db.execute(
          sql`SELECT * FROM fitness.food_entry
              WHERE user_id = ${ctx.userId}
                AND confirmed = true
                AND date >= ${input.startDate}::date
                AND date <= ${input.endDate}::date
                AND meal = ${input.meal}
              ORDER BY date ASC, meal ASC, food_name ASC`,
        );
        return rows;
      }
      const rows = await ctx.db.execute(
        sql`SELECT * FROM fitness.food_entry
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
      const rows = await ctx.db.execute(
        sql`SELECT * FROM fitness.food_entry
            WHERE user_id = ${ctx.userId}
              AND confirmed = true
              AND date = ${input.date}::date
            ORDER BY meal ASC, food_name ASC`,
      );
      return rows;
    }),

  /** Get daily calorie/macro totals aggregated by day */
  dailyTotals: cachedProtectedQuery(CacheTTL.SHORT)
    .input(z.object({ days: z.number().default(30) }))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.execute(
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
        query: z.string().min(1),
        limit: z.number().int().positive().default(20),
      }),
    )
    .query(async ({ ctx, input }) => {
      const searchPattern = `%${input.query}%`;
      const rows = await ctx.db.execute(
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

    const rows = await ctx.db.execute(
      sql`INSERT INTO fitness.food_entry (
            user_id, provider_id, date, meal, food_name, food_description, category, number_of_units,
            calories, protein_g, carbs_g, fat_g,
            saturated_fat_g, polyunsaturated_fat_g, monounsaturated_fat_g, trans_fat_g,
            cholesterol_mg, sodium_mg, potassium_mg, fiber_g, sugar_g,
            vitamin_a_mcg, vitamin_c_mg, vitamin_d_mcg, vitamin_e_mg, vitamin_k_mcg,
            vitamin_b1_mg, vitamin_b2_mg, vitamin_b3_mg, vitamin_b5_mg, vitamin_b6_mg,
            vitamin_b7_mcg, vitamin_b9_mcg, vitamin_b12_mcg,
            calcium_mg, iron_mg, magnesium_mg, zinc_mg, selenium_mcg,
            copper_mg, manganese_mg, chromium_mcg, iodine_mcg,
            omega3_mg, omega6_mg
          ) VALUES (
            ${ctx.userId}, ${DOFEK_PROVIDER_ID}, ${input.date}::date,
            ${input.meal ?? null}, ${input.foodName}, ${input.foodDescription ?? null},
            ${input.category ?? null}, ${input.numberOfUnits ?? null},
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
          ) RETURNING *`,
    );
    return rows[0];
  }),

  /** Update an existing food entry by id */
  update: protectedProcedure.input(updateFoodEntrySchema).mutation(async ({ ctx, input }) => {
    const { id, ...fields } = input;
    const setClauses: ReturnType<typeof sql>[] = [];

    for (const [fieldName, columnName] of Object.entries(fieldColumnMap)) {
      const value = fields[fieldName as keyof typeof fields];
      if (value !== undefined) {
        if (fieldName === "date") {
          setClauses.push(
            value !== null
              ? sql`${sql.identifier(columnName)} = ${value as string}::date`
              : sql`${sql.identifier(columnName)} = NULL`,
          );
        } else if (value === null) {
          setClauses.push(sql`${sql.identifier(columnName)} = NULL`);
        } else {
          setClauses.push(sql`${sql.identifier(columnName)} = ${value}`);
        }
      }
    }

    if (setClauses.length === 0) return null;

    const setExpression = sql.join(setClauses, sql`, `);
    const rows = await ctx.db.execute(
      sql`UPDATE fitness.food_entry SET ${setExpression} WHERE user_id = ${ctx.userId} AND confirmed = true AND id = ${id} RETURNING *`,
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
        foodName: z.string().min(1),
        calories: z.number().int().nonnegative(),
        proteinG: z.number().nonnegative().nullish(),
        carbsG: z.number().nonnegative().nullish(),
        fatG: z.number().nonnegative().nullish(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await ensureDofekProvider(ctx.db);

      const rows = await ctx.db.execute(
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
      return rows[0];
    }),
});
