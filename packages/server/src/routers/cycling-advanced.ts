import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  selectedChartCustomRangeQuery,
  selectedChartRangeQuery,
  selectedChartRangeSchema,
} from "../lib/chart-range.ts";
import type { ActivitySensorStore } from "../repositories/activity-repository.ts";
import {
  type ActivityVariabilityEmptyReason,
  CyclingAdvancedRepository,
} from "../repositories/cycling-advanced-repository.ts";

export type { ActivityVariabilityEmptyReason } from "../repositories/cycling-advanced-repository.ts";

import { CacheTTL, router } from "../trpc.ts";

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
  dailyMeanLoad: number;
  dailyLoadStandardDeviation: number;
  method: {
    formula: string;
    calendar: string;
    activityScope: string;
    interpretation: string;
    source: {
      title: string;
      url: string;
    };
  };
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
  emptyReason: ActivityVariabilityEmptyReason | null;
}

export interface VerticalAscentRow {
  date: string;
  activityName: string;
  activityType: string;
  modality: string | null;
  verticalAscentRate: number;
  elevationGainMeters: number;
  elapsedMinutes: number;
}

export interface PedalDynamicsRow {
  date: string;
  activityName: string;
  leftRightBalance: number;
  avgTorqueEffectiveness: number;
  avgPedalSmoothness: number;
}

export const cyclingAdvancedRouter = router({
  rampRate: selectedChartRangeQuery(
    "cyclingAdvanced.rampRate",
    CacheTTL.LONG,
    async ({ ctx, range }): Promise<RampRateResult> => {
      const sensorStore = requireSensorStore(ctx.sensorStore, "cyclingAdvanced");
      const repo = new CyclingAdvancedRepository(ctx.db, ctx.userId, ctx.timezone, sensorStore);
      const result = await repo.getRampRate(range.days);
      return {
        weeks: result.weeks.map((week) => week.toDetail()),
        currentRampRate: result.currentRampRate,
        recommendation: result.recommendation,
      };
    },
  ),

  trainingMonotony: selectedChartRangeQuery(
    "cyclingAdvanced.trainingMonotony",
    CacheTTL.LONG,
    async ({ ctx, range }): Promise<TrainingMonotonyWeek[]> => {
      const sensorStore = requireSensorStore(ctx.sensorStore, "cyclingAdvanced");
      const repo = new CyclingAdvancedRepository(ctx.db, ctx.userId, ctx.timezone, sensorStore);
      const models = await repo.getTrainingMonotony(range.days);
      return models.map((model) => model.toDetail());
    },
  ),

  activityVariability: selectedChartCustomRangeQuery(
    "cyclingAdvanced.activityVariability",
    CacheTTL.LONG,
    z.object({
      days: selectedChartRangeSchema("cyclingAdvanced.activityVariability"),
      limit: z.number().min(1).max(100).default(20),
      offset: z.number().min(0).default(0),
    }),
    async ({ ctx, input, range }): Promise<ActivityVariabilityResult> => {
      const sensorStore = requireSensorStore(ctx.sensorStore, "cyclingAdvanced");
      const repo = new CyclingAdvancedRepository(ctx.db, ctx.userId, ctx.timezone, sensorStore);
      const { models, totalCount, emptyReason } = await repo.getActivityVariability(
        range.days,
        input.limit,
        input.offset,
      );
      return {
        rows: models.map((model) => model.toDetail()),
        totalCount,
        emptyReason,
      };
    },
  ),

  verticalAscentRate: selectedChartRangeQuery(
    "cyclingAdvanced.verticalAscentRate",
    CacheTTL.LONG,
    async ({ ctx, range }): Promise<VerticalAscentRow[]> => {
      const sensorStore = requireSensorStore(ctx.sensorStore, "cyclingAdvanced");
      const repo = new CyclingAdvancedRepository(ctx.db, ctx.userId, ctx.timezone, sensorStore);
      const models = await repo.getVerticalAscentRates(range.days);
      return models.map((model) => model.toDetail());
    },
  ),

  pedalDynamics: selectedChartRangeQuery(
    "cyclingAdvanced.pedalDynamics",
    CacheTTL.LONG,
    async ({ ctx, range }): Promise<PedalDynamicsRow[]> => {
      const sensorStore = requireSensorStore(ctx.sensorStore, "cyclingAdvanced");
      const repo = new CyclingAdvancedRepository(ctx.db, ctx.userId, ctx.timezone, sensorStore);
      const models = await repo.getPedalDynamics(range.days);
      return models.map((model) => model.toDetail());
    },
  ),
});
