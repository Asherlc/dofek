import { z } from "zod";
import { logger } from "../logger.ts";
import { FoodRepository } from "../repositories/food-repository.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

const mealValues = ["breakfast", "lunch", "dinner", "snack", "other"] as const;

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
});
