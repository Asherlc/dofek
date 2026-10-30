import {
  runningDynamicsResponseSchema,
  runningDynamicsRowsResponseSchema,
  runningResponseVersionSchema,
  toRunningDynamicsRowsV1,
} from "@dofek/training/running-response";

export type { RunningDynamicsRow } from "@dofek/training/running-response";

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  makeTrainingChartAvailability,
  trainingChartAvailabilitySchema,
} from "../contracts/training-chart-availability.ts";
import {
  selectedChartCustomRangeQuery,
  selectedChartRangeQuery,
  selectedChartRangeSchema,
} from "../lib/chart-range.ts";
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

export interface PaceTrendRow {
  date: string;
  activityName: string;
  paceSecondsPerKm: number;
  distanceKm: number;
  durationMinutes: number;
}

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
  dynamics: selectedChartCustomRangeQuery(
    "running.dynamics",
    CacheTTL.LONG,
    z.object({
      days: selectedChartRangeSchema("running.dynamics"),
      responseVersion: runningResponseVersionSchema,
    }),
    async ({ ctx, input, range }) => {
      const sensorStore = requireSensorStore(ctx.sensorStore, "running.dynamics");
      const repo = new RunningRepository(ctx.db, ctx.userId, ctx.timezone, sensorStore);
      const data = (await repo.getDynamics(range.days)).map((activity) => activity.toDetail());
      return input.responseVersion === 1 ? toRunningDynamicsRowsV1(data) : data;
    },
    runningDynamicsRowsResponseSchema,
    { keyVersion: "running-response-negotiation-v1" },
  ),

  paceTrend: selectedChartRangeQuery("running.paceTrend", CacheTTL.LONG, async ({ ctx, range }) => {
    const sensorStore = requireSensorStore(ctx.sensorStore, "running.paceTrend");
    const repo = new RunningRepository(ctx.db, ctx.userId, ctx.timezone, sensorStore);
    return (await repo.getPaceTrend(range.days)).map((activity) => activity.toDetail());
  }),

  dynamicsV2: selectedChartCustomRangeQuery(
    "running.dynamicsV2",
    CacheTTL.LONG,
    z.object({
      days: selectedChartRangeSchema("running.dynamicsV2"),
      responseVersion: runningResponseVersionSchema,
    }),
    async ({ ctx, input, range }) => {
      const sensorStore = requireSensorStore(ctx.sensorStore, "running.dynamicsV2");
      const repo = new RunningRepository(ctx.db, ctx.userId, ctx.timezone, sensorStore);
      const data = (await repo.getDynamics(range.days)).map((activity) => activity.toDetail());
      if (input.responseVersion === 1) {
        const legacyData = toRunningDynamicsRowsV1(data);
        return {
          data: legacyData,
          availability: runningAvailability(
            "running dynamics data",
            "running dynamics data",
            legacyData.length,
          ),
        };
      }
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
    runningDynamicsResponseSchema,
    { keyVersion: "running-response-negotiation-v1" },
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
