import { dateWindowInput } from "../lib/date-window.ts";
import { NutritionRepository } from "../repositories/nutrition-repository.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

export const nutritionRouter = router({
  daily: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(dateWindowInput)
    .query(async ({ ctx, input }) => {
      const startDate = computeStartDate(input.endDate, input.days);
      const repo = new NutritionRepository(ctx.db, ctx.userId, ctx.timezone);
      const days = await repo.getDailyNutrition(startDate);
      return days.map((day) => day.toDetail());
    }),
});

/**
 * Compute the exclusive lower bound date string (YYYY-MM-DD) for a date window.
 * Mirrors the SQL expression `endDate::date - days::int` in plain JS so the
 * repository can accept a plain string instead of a SQL fragment.
 */
function computeStartDate(endDate: string, days: number): string {
  const end = new Date(endDate);
  end.setUTCDate(end.getUTCDate() - days);
  return end.toISOString().slice(0, 10);
}
