import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  makeTrainingChartAvailability,
  trainingChartAvailabilitySchema,
} from "../contracts/training-chart-availability.ts";
import { selectedChartRangeQuery } from "../lib/chart-range.ts";
import { dateStringSchema } from "../lib/typed-sql.ts";
import type { ActivitySensorStore } from "../repositories/activity-repository.ts";
import { RunningRepository } from "../repositories/running-repository.ts";
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

const runningDynamicsRowSchema = z.object({
  activityId: z.string(),
  date: dateStringSchema,
  activityName: z.string(),
  cadence: z.number(),
  strideLengthMeters: z.number().nullable(),
  stanceTimeMs: z.number().nullable(),
  verticalOscillationMm: z.number().nullable(),
  paceSecondsPerKm: z.number(),
  distanceKm: z.number(),
});

const paceTrendRowSchema = z.object({
  date: dateStringSchema,
  activityName: z.string(),
  paceSecondsPerKm: z.number(),
  distanceKm: z.number(),
  durationMinutes: z.number(),
});

const runningChartOutput = <TRow extends z.ZodType>(rowSchema: TRow) =>
  z.object({
    data: z.array(rowSchema),
    availability: trainingChartAvailabilitySchema,
  });

const RUNNING_SENSOR_SOURCE = "Running activity sensor summaries";

function runningAvailability(chartLabel: string, dataLabel: string, observedCount: number) {
  return makeTrainingChartAvailability({
    sourceLabel: RUNNING_SENSOR_SOURCE,
    observedCount,
    minimumCount: 1,
    message:
      observedCount === 0
        ? `No ${chartLabel} is available from ${RUNNING_SENSOR_SOURCE}. Record at least 1 running activity with ${dataLabel} to show this chart.`
        : `${chartLabel} is available from ${RUNNING_SENSOR_SOURCE}.`,
  });
}

export const runningRouter = router({
  dynamics: selectedChartRangeQuery("running.dynamics", CacheTTL.LONG, async ({ ctx, range }) => {
    const sensorStore = requireSensorStore(ctx.sensorStore, "running.dynamics");
    const repo = new RunningRepository(ctx.db, ctx.userId, ctx.timezone, sensorStore);
    return (await repo.getDynamics(range.days)).map((activity) => activity.toDetail());
  }),

  paceTrend: selectedChartRangeQuery("running.paceTrend", CacheTTL.LONG, async ({ ctx, range }) => {
    const sensorStore = requireSensorStore(ctx.sensorStore, "running.paceTrend");
    const repo = new RunningRepository(ctx.db, ctx.userId, ctx.timezone, sensorStore);
    return (await repo.getPaceTrend(range.days)).map((activity) => activity.toDetail());
  }),

  dynamicsV2: selectedChartRangeQuery(
    "running.dynamicsV2",
    CacheTTL.LONG,
    async ({ ctx, range }) => {
      const sensorStore = requireSensorStore(ctx.sensorStore, "running.dynamicsV2");
      const repo = new RunningRepository(ctx.db, ctx.userId, ctx.timezone, sensorStore);
      const data = (await repo.getDynamics(range.days)).map((activity) => activity.toDetail());
      return {
        data,
        availability: runningAvailability(
          "running dynamics data",
          "running dynamics data",
          data.length,
        ),
      };
    },
    { outputSchema: runningChartOutput(runningDynamicsRowSchema) },
  ),

  paceTrendV2: selectedChartRangeQuery(
    "running.paceTrendV2",
    CacheTTL.LONG,
    async ({ ctx, range }) => {
      const sensorStore = requireSensorStore(ctx.sensorStore, "running.paceTrendV2");
      const repo = new RunningRepository(ctx.db, ctx.userId, ctx.timezone, sensorStore);
      const data = (await repo.getPaceTrend(range.days)).map((activity) => activity.toDetail());
      return {
        data,
        availability: runningAvailability("running pace data", "pace data", data.length),
      };
    },
    { outputSchema: runningChartOutput(paceTrendRowSchema) },
  ),
});
