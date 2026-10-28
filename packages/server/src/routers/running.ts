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
  cadence: number | null;
  cadenceBasis: "cadence_samples" | "step_intervals" | "unknown";
  cadenceObservedSeconds: number | null;
  cadenceCoveragePercent: number | null;
  strideLengthMeters: number | null;
  stanceTimeMs: number | null;
  verticalOscillationMm: number | null;
  paceSecondsPerKm: number | null;
  distanceKm: number | null;
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
  cadence: z.number().nullable(),
  cadenceBasis: z.enum(["cadence_samples", "step_intervals", "unknown"]),
  cadenceObservedSeconds: z.number().nullable(),
  cadenceCoveragePercent: z.number().nullable(),
  strideLengthMeters: z.number().nullable(),
  stanceTimeMs: z.number().nullable(),
  verticalOscillationMm: z.number().nullable(),
  paceSecondsPerKm: z.number().nullable(),
  distanceKm: z.number().nullable(),
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
    messages: {
      available: `${chartLabel} is available from ${RUNNING_SENSOR_SOURCE}.`,
      insufficientData: `No ${chartLabel} is available from ${RUNNING_SENSOR_SOURCE}. Record at least 1 running activity with ${dataLabel} to show this chart.`,
    },
  });
}

export const runningRouter = router({
  dynamics: selectedChartRangeQuery(
    "running.dynamics",
    CacheTTL.LONG,
    async ({ ctx, range }) => {
      const sensorStore = requireSensorStore(ctx.sensorStore, "running.dynamics");
      const repo = new RunningRepository(ctx.db, ctx.userId, ctx.timezone, sensorStore);
      return (await repo.getDynamics(range.days)).map((activity) => activity.toDetail());
    },
    { keyVersion: "running-cadence-evidence-v1", outputSchema: z.array(runningDynamicsRowSchema) },
  ),

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
        cadenceAvailability: makeTrainingChartAvailability({
          sourceLabel: RUNNING_SENSOR_SOURCE,
          observedCount: data.filter((row) => row.cadence !== null).length,
          minimumCount: 1,
          messages: {
            available: "Running cadence is available.",
            insufficientData:
              "No cadence samples or usable imported step intervals are available for these runs. Check the selected range and Apple Health sync status.",
          },
        }),
        availability: makeTrainingChartAvailability({
          sourceLabel: RUNNING_SENSOR_SOURCE,
          observedCount: data.length,
          minimumCount: 1,
          messages: {
            available: "Running form measurements are available.",
            insufficientData:
              "No running form measurements are available for these runs. Check the selected range and sync status.",
          },
        }),
      };
    },
    {
      keyVersion: "running-cadence-evidence-v1",
      outputSchema: runningChartOutput(runningDynamicsRowSchema).extend({
        cadenceAvailability: trainingChartAvailabilitySchema,
      }),
    },
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
