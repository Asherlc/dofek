import { TRPCError } from "@trpc/server";
import { z } from "zod";
import type { ActivitySensorStore } from "../repositories/activity-repository.ts";
import { RunningRepository } from "../repositories/running-repository.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

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

export interface RunningDynamicsRow {
  activityId: string;
  date: string;
  activityName: string;
  cadence: number;
  strideLengthMeters: number | null;
  stanceTimeMs: number | null;
  verticalOscillationMm: number | null;
  paceSecondsPerKm: number;
  distanceKm: number;
}

export interface PaceTrendRow {
  date: string;
  activityName: string;
  paceSecondsPerKm: number;
  distanceKm: number;
  durationMinutes: number;
}

const daysInput = z.object({ days: z.number().default(90) });

export const runningRouter = router({
  dynamics: cachedProtectedQuery(CacheTTL.LONG)
    .input(daysInput)
    .query(async ({ ctx, input }) => {
      const sensorStore = requireSensorStore(ctx.sensorStore, "running.dynamics");
      const repo = new RunningRepository(ctx.userId, ctx.timezone, sensorStore);
      return (await repo.getDynamics(input.days)).map((activity) => activity.toDetail());
    }),

  paceTrend: cachedProtectedQuery(CacheTTL.LONG)
    .input(daysInput)
    .query(async ({ ctx, input }) => {
      const sensorStore = requireSensorStore(ctx.sensorStore, "running.paceTrend");
      const repo = new RunningRepository(ctx.userId, ctx.timezone, sensorStore);
      return (await repo.getPaceTrend(input.days)).map((activity) => activity.toDetail());
    }),
});
