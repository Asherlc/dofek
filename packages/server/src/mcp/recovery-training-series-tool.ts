import { ACTIVITY_MODALITIES, CANONICAL_ACTIVITY_TYPES } from "@dofek/training/activity-types";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { dateSchema } from "../lib/date-schema.ts";
import { AnalyticalTrainingLoadRepository } from "../repositories/analytical-training-load-repository.ts";
import { BodyRepository } from "../repositories/body-repository.ts";
import { DailyMetricsRepository } from "../repositories/daily-metrics-repository.ts";
import { FoodRepository } from "../repositories/food-repository.ts";
import { loadDirectWeightObservations } from "../repositories/nearby-weight-repository.ts";
import { listPreSleepActivities } from "../repositories/pre-sleep-activity-repository.ts";
import { RecoveryActivityExposureRepository } from "../repositories/recovery-activity-exposure-repository.ts";
import { RecoveryHealthMetricsRepository } from "../repositories/recovery-health-metrics-repository.ts";
import {
  mapSleep,
  RecoveryTrainingSeriesRepository,
  recoveryTrainingStreamSchema,
} from "../repositories/recovery-training-series-repository.ts";
import {
  analysisTimezoneSchema,
  listSleepEpisodes,
} from "../repositories/sleep-episode-analysis.ts";
import { registerAuthorizedTool } from "./authorized-tool.ts";
import type { DofekMcpContext } from "./context.ts";
import {
  formatSeriesPage,
  type SeriesField,
  seriesRowsSchema,
} from "./recovery-training-response.ts";
import {
  recoveryTrainingFieldSchema,
  recoveryTrainingGrainSchema,
  recoveryTrainingSeriesOutputSchema,
} from "./recovery-training-series-output.ts";
import { requireMcpScope } from "./token-repository.ts";
import { jsonToolResult } from "./tool-result.ts";
import { assertDateRange } from "./tool-utils.ts";

const DEFAULT_STREAMS = ["health", "sleep", "body_weight", "training_load", "activities"] as const;
const MAX_DAYS = 366;
const FIELD_STREAMS = {
  health: "health",
  sleep: "sleep",
  body_weight: "body_weight",
  training_load: "training_load",
  previous_day_training_load: "training_load",
  activity_exposure: "activities",
  nutrition: "nutrition",
} as const;

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
  registerAuthorizedTool(
    server,
    ["health:read", "activity:read", "nutrition:read"],
    "get_recovery_training_series",
    {
      title: "Get Recovery And Training Series",
      description:
        "Align selected recovery, sleep, weight, training, activity and nutrition fields by local day or main sleep. Main sleep can include aggregate workouts between the preceding main wake and sleep onset.",
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      inputSchema: z.object({
        start_date: dateSchema,
        end_date: dateSchema,
        timezone: analysisTimezoneSchema.optional(),
        grain: recoveryTrainingGrainSchema.optional(),
        fields: z
          .array(recoveryTrainingFieldSchema)
          .min(1)
          .max(recoveryTrainingFieldSchema.options.length)
          .optional(),
        streams: z.array(recoveryTrainingStreamSchema).min(1).max(6).optional(),
        providers: z.array(z.string().min(1)).max(20).optional(),
        modalities: z.array(z.enum(ACTIVITY_MODALITIES)).max(ACTIVITY_MODALITIES.length).optional(),
        canonical_activity_types: z
          .array(z.enum(CANONICAL_ACTIVITY_TYPES))
          .max(CANONICAL_ACTIVITY_TYPES.length)
          .optional(),
        required_meals: z
          .array(z.enum(["breakfast", "lunch", "dinner", "snack", "other"]))
          .max(5)
          .optional(),
        workout_finish_after: z
          .string()
          .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
          .optional(),
        cursor: z.string().min(1).optional(),
        limit: z.number().int().min(1).max(MAX_DAYS).optional(),
      }),
      outputSchema: recoveryTrainingSeriesOutputSchema,
    },
    async ({
      start_date,
      end_date,
      timezone,
      grain = "local_day",
      fields,
      streams,
      providers,
      modalities,
      canonical_activity_types,
      required_meals,
      workout_finish_after,
      cursor,
      limit,
    }) => {
      assertDateRange(start_date, end_date);
      if (inclusiveDays(start_date, end_date) > MAX_DAYS) {
        throw new Error(
          `get_recovery_training_series supports at most ${MAX_DAYS} inclusive days per request; split longer ranges into chunks`,
        );
      }
      if (streams && fields) throw new Error("Select fields or streams for a series request.");
      if (grain === "main_sleep" && required_meals?.length) {
        throw new Error("required_meals is available for local_day rows.");
      }
      if (grain !== "main_sleep" && workout_finish_after) {
        throw new Error("workout_finish_after is available for main_sleep rows.");
      }
      const useSleepGrain = grain === "main_sleep";
      const analysisZone = timezone ?? context.timezone;
      const requestedStreams = [
        ...new Set(
          fields?.map((field) => FIELD_STREAMS[field]) ??
            streams ??
            (useSleepGrain ? (["sleep", "activities"] as const) : DEFAULT_STREAMS),
        ),
      ];
      const requestedFields: SeriesField[] = fields
        ? [...new Set(fields)]
        : recoveryTrainingFieldSchema.options.filter((field) =>
            requestedStreams.includes(FIELD_STREAMS[field]),
          );
      const needsNutrition =
        requestedStreams.includes("nutrition") || Boolean(required_meals?.length);
      const needsActivity =
        requestedStreams.includes("activities") || Boolean(workout_finish_after);
      const dailyStreams = requestedStreams.filter(
        (stream) => !useSleepGrain || (stream !== "sleep" && stream !== "activities"),
      );
      if (needsNutrition && !dailyStreams.includes("nutrition")) dailyStreams.push("nutrition");
      if (
        useSleepGrain ||
        requestedStreams.some((stream) => ["health", "sleep", "body_weight"].includes(stream))
      ) {
        requireMcpScope(context.scopes, "health:read");
      }
      if (requestedStreams.includes("training_load") || needsActivity) {
        requireMcpScope(context.scopes, "activity:read");
      }
      if (needsNutrition) {
        requireMcpScope(context.scopes, "nutrition:read");
      }
      const needsSensorStore =
        useSleepGrain ||
        requestedStreams.some((stream) =>
          ["health", "sleep", "body_weight", "training_load"].includes(stream),
        );
      if (needsSensorStore && !context.sensorStore) {
        throw new Error("get_recovery_training_series requires the ClickHouse analytics store");
      }
      const sensorStore = context.sensorStore;
      const sleepRange = (startDate: string, endDate: string) => {
        if (!sensorStore) throw new Error("Sleep series requires the ClickHouse analytics store");
        return listSleepEpisodes(sensorStore, {
          userId: context.userId,
          startDate,
          endDate,
          profileTimezone: context.timezone,
          analysisTimezone: timezone,
          alignToProfileTimezone: true,
          providers,
        });
      };
      const repository = new RecoveryTrainingSeriesRepository(
        {
          ...(requestedStreams.includes("health") && sensorStore
            ? {
                dailyMetrics: new RecoveryHealthMetricsRepository(
                  new DailyMetricsRepository(context.db, context.userId, analysisZone, sensorStore),
                  sensorStore,
                  context.userId,
                  analysisZone,
                ),
              }
            : {}),
          ...(requestedStreams.includes("sleep") && sensorStore
            ? { sleep: { listRange: sleepRange } }
            : {}),
          ...(requestedStreams.includes("body_weight") && sensorStore
            ? {
                body: new BodyRepository(sensorStore, context.userId, analysisZone),
                weightObservations: {
                  listRange: (startDate: string, endDate: string) =>
                    loadDirectWeightObservations(
                      sensorStore,
                      context.userId,
                      analysisZone,
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
                  analysisZone,
                ),
              }
            : {}),
          ...(requestedStreams.includes("activities")
            ? {
                activities: new RecoveryActivityExposureRepository(
                  context.db,
                  context.userId,
                  analysisZone,
                ),
              }
            : {}),
          ...(needsNutrition
            ? { nutrition: new FoodRepository(context.db, context.userId, analysisZone) }
            : {}),
        },
        analysisZone,
      );
      const filters = {
        providers: providers ?? [],
        modalities: modalities ?? [],
        ...(canonical_activity_types && { canonicalTypes: canonical_activity_types }),
        ...(timezone && { datePolicy: "analysis_timezone" as const }),
      };
      const lookback = new Date(`${start_date}T00:00:00Z`);
      lookback.setUTCDate(lookback.getUTCDate() - 3);
      const [base, episodes] = await Promise.all([
        repository.listRange(start_date, end_date, dailyStreams, filters),
        useSleepGrain ? sleepRange(lookback.toISOString().slice(0, 10), end_date) : [],
      ]);
      const baseRows = seriesRowsSchema.parse(base.rows);
      const byDate = new Map(baseRows.map((row) => [row.date, row]));
      const preceding =
        useSleepGrain && needsActivity
          ? await listPreSleepActivities(context.db, context.userId, episodes, analysisZone, {
              ...filters,
              canonicalTypes: canonical_activity_types ?? [],
            })
          : null;
      const rows = useSleepGrain
        ? episodes
            .filter(({ date }) => date >= start_date)
            .map((episode) => ({
              ...byDate.get(episode.date),
              date: episode.date,
              row_id: episode.timing.selected_session_id,
              ...(requestedStreams.includes("sleep") && { sleep: mapSleep(episode) }),
              ...(preceding && {
                activity_exposure: preceding.get(episode.timing.selected_session_id),
              }),
            }))
        : baseRows.filter(
            (row) =>
              required_meals?.every((meal) => row.nutrition?.recorded_meal_labels.includes(meal)) ??
              true,
          );
      return jsonToolResult({
        ...base,
        requested_streams: requestedStreams,
        requested_fields: requestedFields,
        grain,
        calendar_day_count: inclusiveDays(start_date, end_date),
        filters: {
          ...base.filters,
          ...(canonical_activity_types && { canonical_activity_types }),
          ...(required_meals && { required_meals }),
        },
        interpretation: {
          ...base.interpretation,
          date_alignment: useSleepGrain
            ? "Main sleeps are assigned to local wake dates. An open episode uses its local start date and has no known wake date."
            : "Rows use local calendar dates. Nutrition retains the stored date of the canonical contribution set.",
          filter_scope:
            "Providers select sleep observations and match activity group members. Modalities and canonical types filter activities and load. Required meals select dates by recorded nutrition labels.",
        },
        ...formatSeriesPage(rows, requestedFields, {
          workoutFinishAfter: workout_finish_after ? `${workout_finish_after}:00` : undefined,
          cursor,
          limit: limit ?? (useSleepGrain ? 90 : undefined),
        }),
      });
    },
  );
}
