import { TRPCError } from "@trpc/server";
import { z } from "zod";
import type { ActivitySensorStore } from "../repositories/activity-repository.ts";
import { CyclingAdvancedRepository } from "../repositories/cycling-advanced-repository.ts";
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

export interface RampRateWeek {
  week: string;
  ctlStart: number;
  ctlEnd: number;
  rampRate: number;
}

export interface RampRateResult {
  weeks: RampRateWeek[];
  currentRampRate: number;
  recommendation: string;
}

export interface TrainingMonotonyWeek {
  week: string;
  monotony: number;
  strain: number;
  weeklyLoad: number;
}

export interface ActivityVariabilityRow {
  activityId: string;
  date: string;
  activityName: string;
  normalizedPower: number;
  averagePower: number;
  variabilityIndex: number;
  intensityFactor: number;
}

export interface ActivityVariabilityResult {
  rows: ActivityVariabilityRow[];
  totalCount: number;
}

export interface VerticalAscentRow {
  date: string;
  activityName: string;
  verticalAscentRate: number;
  elevationGainMeters: number;
  climbingMinutes: number;
}

export interface PedalDynamicsRow {
  date: string;
  activityName: string;
  leftRightBalance: number;
  avgTorqueEffectiveness: number;
  avgPedalSmoothness: number;
}

const daysInput = z.object({ days: z.number().default(90) });
const rollingWindowCache = { maxAge: CacheTTL.LONG, expiresAt: "localDayBoundary" } as const;

export const cyclingAdvancedRouter = router({
  rampRate: cachedProtectedQuery(rollingWindowCache)
    .input(daysInput)
    .query(async ({ ctx, input }): Promise<RampRateResult> => {
      const sensorStore = requireSensorStore(ctx.sensorStore, "cyclingAdvanced");
      const repo = new CyclingAdvancedRepository(ctx.db, ctx.userId, ctx.timezone, sensorStore);
      const result = await repo.getRampRate(input.days);
      return {
        weeks: result.weeks.map((week) => week.toDetail()),
        currentRampRate: result.currentRampRate,
        recommendation: result.recommendation,
      };
    }),

  trainingMonotony: cachedProtectedQuery(rollingWindowCache)
    .input(daysInput)
    .query(async ({ ctx, input }): Promise<TrainingMonotonyWeek[]> => {
      const sensorStore = requireSensorStore(ctx.sensorStore, "cyclingAdvanced");
      const repo = new CyclingAdvancedRepository(ctx.db, ctx.userId, ctx.timezone, sensorStore);
      const models = await repo.getTrainingMonotony(input.days);
      return models.map((model) => model.toDetail());
    }),

  activityVariability: cachedProtectedQuery(rollingWindowCache)
    .input(
      z.object({
        days: z.number().default(90),
        limit: z.number().min(1).max(100).default(20),
        offset: z.number().min(0).default(0),
      }),
    )
    .query(async ({ ctx, input }): Promise<ActivityVariabilityResult> => {
      const sensorStore = requireSensorStore(ctx.sensorStore, "cyclingAdvanced");
      const repo = new CyclingAdvancedRepository(ctx.db, ctx.userId, ctx.timezone, sensorStore);
      const { models, totalCount } = await repo.getActivityVariability(
        input.days,
        input.limit,
        input.offset,
      );
      return {
        rows: models.map((model) => model.toDetail()),
        totalCount,
      };
    }),

  verticalAscentRate: cachedProtectedQuery(rollingWindowCache)
    .input(daysInput)
    .query(async ({ ctx, input }): Promise<VerticalAscentRow[]> => {
      const sensorStore = requireSensorStore(ctx.sensorStore, "cyclingAdvanced");
      const repo = new CyclingAdvancedRepository(ctx.db, ctx.userId, ctx.timezone, sensorStore);
      const models = await repo.getVerticalAscentRates(input.days);
      return models.map((model) => model.toDetail());
    }),

  pedalDynamics: cachedProtectedQuery(rollingWindowCache)
    .input(daysInput)
    .query(async ({ ctx, input }): Promise<PedalDynamicsRow[]> => {
      const sensorStore = requireSensorStore(ctx.sensorStore, "cyclingAdvanced");
      const repo = new CyclingAdvancedRepository(ctx.db, ctx.userId, ctx.timezone, sensorStore);
      const models = await repo.getPedalDynamics(input.days);
      return models.map((model) => model.toDetail());
    }),
});
