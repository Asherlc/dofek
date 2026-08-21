import { TRPCError } from "@trpc/server";
import { z } from "zod";
import type { ActivitySensorStore } from "../repositories/activity-repository.ts";
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

function requireSensorStore(
  sensorStore: ActivitySensorStore | undefined,
  feature: string,
): ActivitySensorStore {
  if (!sensorStore) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `${feature} requires the ClickHouse activity analytics store. Set CLICKHOUSE_URL and retry.`,
    });
  }
  return sensorStore;
}

const maxTrendDays = 3650;
const maxTrendWeeks = 520;

export const trendsRouter = router({
  daily: cachedProtectedQuery({ maxAge: CacheTTL.LONG })
    .input(z.object({ days: z.number().int().min(1).max(maxTrendDays).default(365) }))
    .query(async ({ ctx, input }): Promise<DailyTrendRow[]> => {
      const sensorStore = requireSensorStore(ctx.sensorStore, "trends.daily");
      const repo = new TrendsRepository(ctx.userId, sensorStore);
      return (await repo.getDaily(input.days)).map((row) => ({
        date: row.period,
        ...row.toDetail(),
      }));
    }),

  weekly: cachedProtectedQuery({ maxAge: CacheTTL.LONG })
    .input(z.object({ weeks: z.number().int().min(1).max(maxTrendWeeks).default(52) }))
    .query(async ({ ctx, input }): Promise<WeeklyTrendRow[]> => {
      const sensorStore = requireSensorStore(ctx.sensorStore, "trends.weekly");
      const repo = new TrendsRepository(ctx.userId, sensorStore);
      return (await repo.getWeekly(input.weeks)).map((row) => ({
        week: row.period,
        ...row.toDetail(),
      }));
    }),
});
