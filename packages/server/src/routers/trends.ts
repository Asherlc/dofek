import { z } from "zod";
import { TrendsRepository } from "../repositories/trends-repository.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

export interface DailyTrendRow {
  date: string;
  avgHr: number | null;
  maxHr: number | null;
  avgPower: number | null;
  maxPower: number | null;
  avgCadence: number | null;
  avgSpeed: number | null;
  totalSamples: number;
  hrSamples: number;
  powerSamples: number;
  activityCount: number;
}

export interface WeeklyTrendRow {
  week: string;
  avgHr: number | null;
  maxHr: number | null;
  avgPower: number | null;
  maxPower: number | null;
  avgCadence: number | null;
  avgSpeed: number | null;
  totalSamples: number;
  hrSamples: number;
  powerSamples: number;
  activityCount: number;
}

export const trendsRouter = router({
  daily: cachedProtectedQuery(CacheTTL.LONG)
    .input(z.object({ days: z.number().default(365) }))
    .query(async ({ ctx, input }): Promise<DailyTrendRow[]> => {
      const repo = new TrendsRepository(ctx.db, ctx.userId);
      return (await repo.getDaily(input.days)).map((row) => ({
        date: row.period,
        ...row.toDetail(),
      }));
    }),

  weekly: cachedProtectedQuery(CacheTTL.LONG)
    .input(z.object({ weeks: z.number().default(52) }))
    .query(async ({ ctx, input }): Promise<WeeklyTrendRow[]> => {
      const repo = new TrendsRepository(ctx.db, ctx.userId);
      return (await repo.getWeekly(input.weeks)).map((row) => ({
        week: row.period,
        ...row.toDetail(),
      }));
    }),
});
