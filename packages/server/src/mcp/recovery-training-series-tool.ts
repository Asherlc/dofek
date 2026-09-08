import { ACTIVITY_MODALITIES } from "@dofek/training/activity-types";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { dateSchema } from "../lib/date-schema.ts";
import { AnalyticalTrainingLoadRepository } from "../repositories/analytical-training-load-repository.ts";
import { BodyRepository } from "../repositories/body-repository.ts";
import { DailyMetricsRepository } from "../repositories/daily-metrics-repository.ts";
import { FoodRepository } from "../repositories/food-repository.ts";
import { loadDirectWeightObservations } from "../repositories/nearby-weight-repository.ts";
import { RecoveryActivityExposureRepository } from "../repositories/recovery-activity-exposure-repository.ts";
import { RecoveryHealthMetricsRepository } from "../repositories/recovery-health-metrics-repository.ts";
import {
  RecoveryTrainingSeriesRepository,
  recoveryTrainingStreamSchema,
} from "../repositories/recovery-training-series-repository.ts";
import { SleepRepository } from "../repositories/sleep-repository.ts";
import { SubjectiveRepository } from "../repositories/subjective-repository.ts";
import type { DofekMcpContext } from "./context.ts";
import { recoveryTrainingSeriesOutputSchema } from "./recovery-training-series-output.ts";
import { requireMcpScope } from "./token-repository.ts";
import { jsonToolResult } from "./tool-result.ts";
import { assertDateRange } from "./tool-utils.ts";

const DEFAULT_STREAMS = [
  "health",
  "sleep",
  "body_weight",
  "training_load",
  "subjective",
  "activities",
] as const;
const MAX_DAYS = 366;

function inclusiveDays(startDate: string, endDate: string): number {
  return (
    Math.round(
      (Date.parse(`${endDate}T00:00:00.000Z`) - Date.parse(`${startDate}T00:00:00.000Z`)) /
        86_400_000,
    ) + 1
  );
}

/** Register the compact date-aligned recovery, exposure, and training response primitive. */
export function registerRecoveryTrainingSeriesTool(
  server: McpServer,
  context: DofekMcpContext,
): void {
  server.registerTool(
    "get_recovery_training_series",
    {
      title: "Get Recovery And Training Series",
      description:
        "Return a compact local-date spine of selected recovery, sleep, body-weight, modality-specific load, subjective, activity, and optional nutrition observations. It aligns data but makes no causal claims.",
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      inputSchema: {
        start_date: dateSchema,
        end_date: dateSchema,
        streams: z.array(recoveryTrainingStreamSchema).min(1).max(7).optional(),
        providers: z.array(z.string().min(1)).max(20).optional(),
        modalities: z.array(z.enum(ACTIVITY_MODALITIES)).max(ACTIVITY_MODALITIES.length).optional(),
      },
      outputSchema: recoveryTrainingSeriesOutputSchema,
    },
    async ({ start_date, end_date, streams, providers, modalities }) => {
      assertDateRange(start_date, end_date);
      if (inclusiveDays(start_date, end_date) > MAX_DAYS) {
        throw new Error(
          `get_recovery_training_series supports at most ${MAX_DAYS} inclusive days per request; split longer ranges into chunks`,
        );
      }
      const requestedStreams = [...new Set(streams ?? DEFAULT_STREAMS)];
      if (
        requestedStreams.some((stream) =>
          ["health", "sleep", "body_weight", "subjective"].includes(stream),
        )
      ) {
        requireMcpScope(context.scopes, "health:read");
      }
      if (requestedStreams.includes("training_load") || requestedStreams.includes("activities")) {
        requireMcpScope(context.scopes, "activity:read");
      }
      if (requestedStreams.includes("nutrition")) {
        requireMcpScope(context.scopes, "nutrition:read");
      }
      const needsSensorStore = requestedStreams.some((stream) =>
        ["health", "sleep", "body_weight", "training_load"].includes(stream),
      );
      if (needsSensorStore && !context.sensorStore) {
        throw new Error("get_recovery_training_series requires the ClickHouse analytics store");
      }
      const sensorStore = context.sensorStore;
      const dailyMetrics = new DailyMetricsRepository(context.db, context.userId, context.timezone);
      const repository = new RecoveryTrainingSeriesRepository(
        {
          ...(requestedStreams.includes("health") && sensorStore
            ? {
                dailyMetrics: new RecoveryHealthMetricsRepository(
                  dailyMetrics,
                  sensorStore,
                  context.userId,
                  context.timezone,
                ),
              }
            : {}),
          ...(requestedStreams.includes("sleep") && sensorStore
            ? {
                sleep: new SleepRepository(
                  context.db,
                  context.userId,
                  context.timezone,
                  { kind: "full", paid: true, reason: "paid_grant" },
                  sensorStore,
                ),
              }
            : {}),
          ...(requestedStreams.includes("body_weight") && sensorStore
            ? {
                body: new BodyRepository(sensorStore, context.userId, context.timezone),
                weightObservations: {
                  listRange: (startDate: string, endDate: string) =>
                    loadDirectWeightObservations(
                      sensorStore,
                      context.userId,
                      context.timezone,
                      startDate,
                      endDate,
                    ),
                },
              }
            : {}),
          ...(requestedStreams.includes("training_load") && sensorStore
            ? {
                trainingLoad: new AnalyticalTrainingLoadRepository(
                  context.db,
                  sensorStore,
                  context.userId,
                  context.timezone,
                ),
              }
            : {}),
          ...(requestedStreams.includes("subjective")
            ? {
                subjective: new SubjectiveRepository(context.db, context.userId, context.timezone),
              }
            : {}),
          ...(requestedStreams.includes("activities")
            ? {
                activities: new RecoveryActivityExposureRepository(
                  context.db,
                  context.userId,
                  context.timezone,
                ),
              }
            : {}),
          ...(requestedStreams.includes("nutrition")
            ? { nutrition: new FoodRepository(context.db, context.userId, context.timezone) }
            : {}),
        },
        context.timezone,
      );
      return jsonToolResult(
        await repository.listRange(start_date, end_date, requestedStreams, {
          providers: providers ?? [],
          modalities: modalities ?? [],
        }),
      );
    },
  );
}
