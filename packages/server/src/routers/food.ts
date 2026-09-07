import { formatCalories } from "@dofek/format/format";
import {
  type NutritionCalorieTargetType,
  nutritionSourceResolutionSchema,
  type SelectedDateNutritionIntakeContext,
  selectedDateNutritionIntakeContextSchema,
  selectedDateNutritionSummarySchema,
} from "@dofek/nutrition/selected-date-summary";
import { TRPCError } from "@trpc/server";
import type { Database } from "dofek/db";
import { z } from "zod";
import { logger } from "../logger.ts";
import { FoodRepository, foodEntryRowSchema } from "../repositories/food-repository.ts";
import {
  type CalorieGoalContext,
  SettingsRepository,
} from "../repositories/settings-repository.ts";
import { CacheTTL, cachedProtectedQuery, protectedProcedure, router } from "../trpc.ts";

const mealValues = ["breakfast", "lunch", "dinner", "snack", "other"] as const;

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
});
