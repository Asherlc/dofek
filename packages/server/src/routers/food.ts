import { formatCalories, formatWeekdayTime } from "@dofek/format/format";
import {
  type NutritionCalorieTargetType,
  nutritionSourceResolutionSchema,
  type SelectedDateNutritionIntakeContext,
  selectedDateNutritionIntakeContextSchema,
  selectedDateNutritionSummarySchema,
} from "@dofek/nutrition/selected-date-summary";
import { TRPCError } from "@trpc/server";
import type { Database } from "dofek/db";
import { nutrientFieldsSchema } from "dofek/db/nutrient-columns";
import { withAiGenerationContext } from "dofek/lib/ai-observability";
import { z } from "zod";
import { analyzeNutrition, analyzeNutritionItems } from "../lib/ai-nutrition.ts";
import { invalidateNutritionCaches } from "../lib/nutrition-cache.ts";
import { logger } from "../logger.ts";
import { FoodRepository, foodEntryRowSchema } from "../repositories/food-repository.ts";
import {
  type CalorieGoalContext,
  SettingsRepository,
} from "../repositories/settings-repository.ts";
import { CacheTTL, cachedProtectedQuery, protectedProcedure, router } from "../trpc.ts";

const mealValues = ["breakfast", "lunch", "dinner", "snack", "other"] as const;
type MealValue = (typeof mealValues)[number];

function localizedTimeString(timezone: string, date: Date): string {
  return formatWeekdayTime(date, { timeZone: timezone });
}

function mealFromLocalizedTime(timezone: string, date: Date): MealValue {
  const hourPart = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    hour12: false,
  })
    .formatToParts(date)
    .find((part) => part.type === "hour")?.value;
  const localizedHour = Number.parseInt(hourPart ?? "0", 10);
  if (localizedHour < 10) return "breakfast";
  if (localizedHour < 14) return "lunch";
  if (localizedHour < 17) return "snack";
  return "dinner";
}

function isAiStructuredOutputError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === "AI_NoObjectGeneratedError" ||
    error.message.includes("No object generated") ||
    error.message.includes("Bad JSON character")
  );
}

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
    id: z.guid(),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD format")
      .optional(),
    meal: z.enum(mealValues).nullish(),
    foodName: z.string().min(1).max(500).optional(),
    foodDescription: z.string().max(2000).nullish(),
    category: z.enum(foodCategoryValues).nullish(),
    numberOfUnits: z.number().positive().nullish(),
    // Zod 4 applies `.default({})` even on optional fields, which would wipe nutrients on every update.
    nutrients: z.record(z.string(), z.number().nonnegative()).optional(),
  })
  .merge(nutrientFieldsSchema.partial());

const foodByDateInputSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const foodByDateV2OutputSchema = z.object({
  entries: z.array(foodEntryRowSchema),
  summary: selectedDateNutritionSummarySchema.nullable(),
  resolution: nutritionSourceResolutionSchema,
  intakeContext: selectedDateNutritionIntakeContextSchema.nullable(),
});

async function loadFoodByDate(db: Database, userId: string, timezone: string, date: string) {
  const repo = new FoodRepository(db, userId, timezone);
  const settingsRepo = new SettingsRepository(db, userId);
  const calorieGoal = await settingsRepo.getCalorieGoalContext();
  const [entries, nutrition] = await Promise.all([
    repo.byDate(date),
    repo.nutritionByDate(date, calorieGoal.target),
  ]);
  if (entries.length === 0 && nutrition.resolution.sourceProviders.length === 0) {
    logger.info(`[food] byDate returned 0 rows for userId=${userId} date=${date}`);
  }
  return {
    entries: entries.map((entry) => entry.toDetail()),
    ...nutrition,
    calorieGoal,
  };
}

const calorieTargetLabels: Record<NutritionCalorieTargetType, string> = {
  configured: "Configured daily logged-intake target",
  default: "Default daily logged-intake target",
};

const intakeTargetDescriptions: Record<NutritionCalorieTargetType, string> = {
  configured: "the configured daily logged-intake target",
  default: "the default daily logged-intake target",
};

const INTAKE_CONTEXT_LIMITATION =
  "This target describes logged intake only; it is not an estimate of energy expenditure or calorie balance.";

function createNutritionIntakeContext(
  observedCalories: number,
  calorieGoal: CalorieGoalContext,
): SelectedDateNutritionIntakeContext {
  const maximumCalories = Math.max(observedCalories, calorieGoal.target);
  const differenceCalories = Math.abs(observedCalories - calorieGoal.target);
  const status =
    observedCalories < calorieGoal.target
      ? "below_target"
      : observedCalories > calorieGoal.target
        ? "above_target"
        : "at_target";
  const message =
    status === "at_target"
      ? `Observed logged intake matches ${intakeTargetDescriptions[calorieGoal.type]}.`
      : `Observed logged intake is ${formatCalories(differenceCalories)} ${
          status === "below_target" ? "below" : "above"
        } ${intakeTargetDescriptions[calorieGoal.type]}.`;

  return {
    observedCalories,
    target: {
      calories: calorieGoal.target,
      type: calorieGoal.type,
      label: calorieTargetLabels[calorieGoal.type],
    },
    scale: {
      maximumCalories,
      observedPercentage: (observedCalories / maximumCalories) * 100,
      targetPercentage: (calorieGoal.target / maximumCalories) * 100,
    },
    comparison: {
      status,
      differenceCalories,
      message,
    },
    limitation: INTAKE_CONTEXT_LIMITATION,
  };
}

export const foodRouter = router({
  /** List food entries for a date range, optionally filtered by meal */
  list: cachedProtectedQuery({ maxAge: CacheTTL.SHORT })
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
  byDate: cachedProtectedQuery({ maxAge: CacheTTL.SHORT })
    .input(foodByDateInputSchema)
    .query(async ({ ctx, input }) => {
      const result = await loadFoodByDate(ctx.db, ctx.userId, ctx.timezone, input.date);
      if (result.summary === null) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `${result.resolution.message} Review the overlapping nutrition sources and keep one contribution set for this date, then try again.`,
        });
      }
      return {
        entries: result.entries,
        summary: result.summary,
      };
    }),

  /** Get food entries and conflict-aware nutrition resolution metadata for a date. */
  byDateV2: cachedProtectedQuery({
    maxAge: CacheTTL.SHORT,
    keyVersion: "food.byDateV2:intake-context-v1",
  })
    .input(foodByDateInputSchema)
    .output(foodByDateV2OutputSchema)
    .query(async ({ ctx, input }) => {
      const result = await loadFoodByDate(ctx.db, ctx.userId, ctx.timezone, input.date);
      return {
        entries: result.entries,
        summary: result.summary,
        resolution: result.resolution,
        intakeContext: result.summary
          ? createNutritionIntakeContext(result.summary.calories, result.calorieGoal)
          : null,
      };
    }),

  /** Get daily calorie/macro totals aggregated by day */
  dailyTotals: cachedProtectedQuery({ maxAge: CacheTTL.SHORT })
    .input(z.object({ days: z.number().default(30) }))
    .query(async ({ ctx, input }) => {
      const repo = new FoodRepository(ctx.db, ctx.userId, ctx.timezone);
      const totals = await repo.dailyTotals(input.days);
      return totals.map((total) => total.toDetail());
    }),

  /** Search food entries by name for quick re-logging */
  search: cachedProtectedQuery({ maxAge: CacheTTL.MEDIUM })
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

  /** Direct Dofek food entries that mobile can write back to Apple Health. */
  healthKitWriteBackEntries: protectedProcedure
    .input(
      z.object({
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      }),
    )
    .query(async ({ ctx, input }) => {
      const repo = new FoodRepository(ctx.db, ctx.userId, ctx.timezone);
      return repo.healthKitWriteBackEntries(input.startDate, input.endDate);
    }),

  /** Create a new food entry */
  create: protectedProcedure.input(createFoodEntrySchema).mutation(async ({ ctx, input }) => {
    const repo = new FoodRepository(ctx.db, ctx.userId, ctx.timezone);
    const result = await repo.create(input);
    await invalidateNutritionCaches(ctx.userId);
    return result;
  }),

  /** Update an existing food entry by id */
  update: protectedProcedure.input(updateFoodEntrySchema).mutation(async ({ ctx, input }) => {
    const repo = new FoodRepository(ctx.db, ctx.userId, ctx.timezone);
    const result = await repo.update(input);
    await invalidateNutritionCaches(ctx.userId);
    return result;
  }),

  /** Delete a food entry by id */
  delete: protectedProcedure.input(z.object({ id: z.guid() })).mutation(async ({ ctx, input }) => {
    const repo = new FoodRepository(ctx.db, ctx.userId, ctx.timezone);
    const result = await repo.delete(input.id);
    await invalidateNutritionCaches(ctx.userId);
    return result;
  }),

  /** Analyze a food description with AI and return estimated nutrition data */
  analyzeWithAi: protectedProcedure
    .input(z.object({ description: z.string().min(1).max(500) }))
    .mutation(async ({ ctx, input }) => {
      return withAiGenerationContext({ userId: ctx.userId }, () =>
        analyzeNutrition(input.description),
      );
    }),

  /** Analyze a natural-language meal and return parsed per-item nutrition entries. */
  analyzeItemsWithAi: protectedProcedure
    .input(z.object({ description: z.string().min(1).max(500) }))
    .mutation(async ({ ctx, input }) => {
      const currentTime = new Date();
      const localTime = localizedTimeString(ctx.timezone, currentTime);
      const inferredMeal = mealFromLocalizedTime(ctx.timezone, currentTime);
      let analysis: Awaited<ReturnType<typeof analyzeNutritionItems>>;
      try {
        analysis = await withAiGenerationContext({ userId: ctx.userId }, () =>
          analyzeNutritionItems(input.description, localTime),
        );
      } catch (error) {
        if (isAiStructuredOutputError(error)) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Describe the foods and amounts you want to log.",
          });
        }
        throw error;
      }

      return {
        ...analysis,
        items: analysis.items.map((item) => ({
          ...item,
          meal: inferredMeal,
        })),
      };
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
      const result = await repo.quickAdd(input);
      await invalidateNutritionCaches(ctx.userId);
      return result;
    }),
});
