import { nutrientFieldsSchema } from "dofek/db/nutrient-columns";
import { z } from "zod";
import { analyzeNutrition } from "../lib/ai-nutrition.ts";
import { logger } from "../logger.ts";
import { FoodRepository } from "../repositories/food-repository.ts";
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
    nutrients: nutrientsMapSchema.optional(),
  })
  .merge(nutrientFieldsSchema.partial());

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
      const repo = new FoodRepository(ctx.db, ctx.userId, ctx.timezone);
      const entries = await repo.list(input.startDate, input.endDate, input.meal);
      return entries.map((entry) => entry.toDetail());
    }),

  /** Get all food entries for a specific date, ordered by meal */
  byDate: cachedProtectedQuery(CacheTTL.SHORT)
    .input(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }))
    .query(async ({ ctx, input }) => {
      const repo = new FoodRepository(ctx.db, ctx.userId, ctx.timezone);
      const entries = await repo.byDate(input.date);
      if (entries.length === 0) {
        logger.info(`[food] byDate returned 0 rows for userId=${ctx.userId} date=${input.date}`);
      }
      return entries.map((entry) => entry.toDetail());
    }),

  /** Get daily calorie/macro totals aggregated by day */
  dailyTotals: cachedProtectedQuery(CacheTTL.SHORT)
    .input(z.object({ days: z.number().default(30) }))
    .query(async ({ ctx, input }) => {
      const repo = new FoodRepository(ctx.db, ctx.userId, ctx.timezone);
      const totals = await repo.dailyTotals(input.days);
      return totals.map((total) => total.toDetail());
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
      const repo = new FoodRepository(ctx.db, ctx.userId, ctx.timezone);
      const results = await repo.search(input.query, input.limit);
      return results.map((result) => result.toDetail());
    }),

  /** Create a new food entry */
  create: protectedProcedure.input(createFoodEntrySchema).mutation(async ({ ctx, input }) => {
    const repo = new FoodRepository(ctx.db, ctx.userId, ctx.timezone);
    return repo.create(input);
  }),

  /** Update an existing food entry by id */
  update: protectedProcedure.input(updateFoodEntrySchema).mutation(async ({ ctx, input }) => {
    const repo = new FoodRepository(ctx.db, ctx.userId, ctx.timezone);
    return repo.update(input);
  }),

  /** Delete a food entry by id */
  delete: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const repo = new FoodRepository(ctx.db, ctx.userId, ctx.timezone);
      return repo.delete(input.id);
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
      const repo = new FoodRepository(ctx.db, ctx.userId, ctx.timezone);
      return repo.quickAdd(input);
    }),
});
