import { formatRecordLocalTime } from "@dofek/format/record-local-time";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Database } from "dofek/db";
import { withAccountErasureUserWriteFence } from "dofek/db/account-erasure";
import { enqueueSyncJob } from "dofek/jobs/enqueue-sync-job";
import { providerSyncQueueName } from "dofek/jobs/queues";
import { syncWindowFromTriggerInput, syncWindowToJobData } from "dofek/jobs/sync-window";
import { ProviderModel } from "dofek/providers/provider-model";
import { getAllProviders } from "dofek/providers/registry";
import { z } from "zod";
import { dateSchema } from "../lib/date-schema.ts";
import { hasCurrentProviderAuthFailure } from "../lib/provider-auth-state.ts";
import type { ActivitySensorStore } from "../repositories/activity-repository.ts";
import { ActivityRepository } from "../repositories/activity-repository.ts";
import { BodyRepository } from "../repositories/body-repository.ts";
import { ClimbingRepository } from "../repositories/climbing-repository.ts";
import {
  readFingerLoadingActivity,
  readFingerLoadingRange,
} from "../repositories/climbing-training-log-repository.ts";
import { DailyMetricsRepository } from "../repositories/daily-metrics-repository.ts";
import { FoodRepository } from "../repositories/food-repository.ts";
import {
  type DailyRecoveryBaseline,
  latestRecoveryBaselineMetrics,
  RecoveryBaselineRepository,
} from "../repositories/recovery-baseline-repository.ts";
import {
  fetchRestingHeartRateValuesCte,
  localDateString,
} from "../repositories/resting-heart-rate-query.ts";
import { SleepRepository } from "../repositories/sleep-repository.ts";
import { StrengthRepository } from "../repositories/strength-repository.ts";
import { SubjectiveRepository } from "../repositories/subjective-repository.ts";
import { SyncRepository } from "../repositories/sync-repository.ts";
import {
  CUSTOM_AUTH_PROVIDERS,
  ensureProvidersRegistered,
  toJobId,
} from "../routers/sync-helpers.ts";
import { type McpScope, requireMcpScope } from "./token-repository.ts";

export interface DofekMcpContext {
  db: Pick<Database, "execute" | "select" | "transaction">;
  userId: string;
  scopes: McpScope[];
  timezone: string;
  sensorStore?: ActivitySensorStore;
}

function jsonContent(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

const healthMetricSchema = z.enum([
  "hrv",
  "resting_hr",
  "spo2",
  "respiratory_rate",
  "sleep_efficiency",
  "skin_temp",
  "steps",
  "distance_km",
  "exercise_minutes",
  "flights_climbed",
]);

type HealthMetric = z.infer<typeof healthMetricSchema>;

const healthMetricColumns: Partial<Record<HealthMetric, string>> = {
  hrv: "hrv",
  resting_hr: "resting_hr",
  spo2: "spo2_avg",
  respiratory_rate: "respiratory_rate_avg",
  sleep_efficiency: undefined,
  skin_temp: "skin_temp_c",
  steps: "steps",
  distance_km: "distance_km",
  exercise_minutes: "exercise_minutes",
  flights_climbed: "flights_climbed",
};

const recoveryMetricKeys: Partial<
  Record<HealthMetric, DailyRecoveryBaseline["metrics"][number]["metric"]>
> = {
  hrv: "hrv",
  resting_hr: "resting_heart_rate",
  respiratory_rate: "respiratory_rate",
  sleep_efficiency: "sleep_efficiency",
};

const activityMcpRowSchema = z.object({
  canonical_type: z.string(),
  started_at: z.string(),
  ended_at: z.string().nullable(),
  avg_hr: z.coerce.number().nullable().optional(),
  max_hr: z.coerce.number().nullable().optional(),
  avg_power: z.coerce.number().nullable().optional(),
  max_power: z.coerce.number().nullable().optional(),
});

type ActivityMcpRow = z.infer<typeof activityMcpRowSchema>;

function assertDateRange(startDate: string, endDate: string): void {
  if (startDate > endDate) {
    throw new Error("start_date must be on or before end_date");
  }
}

function daysBetween(startDate: string, endDate: string): number {
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  return Math.round((end.getTime() - start.getTime()) / 86_400_000);
}

function dateDaysBefore(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - days);
  return value.toISOString().slice(0, 10);
}

function isoWeek(date: string): string {
  const value = new Date(`${date}T00:00:00Z`);
  const day = value.getUTCDay() || 7;
  value.setUTCDate(value.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(value.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((value.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${value.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function aggregateNumbers(values: Array<number | null | undefined>) {
  const present = values.filter((value): value is number => value != null);
  if (present.length === 0) return null;
  return {
    avg: present.reduce((total, value) => total + value, 0) / present.length,
    min: Math.min(...present),
    max: Math.max(...present),
  };
}

function healthTrends(
  rows: Array<Record<string, unknown>>,
  baselineRows: DailyRecoveryBaseline[],
  metrics: HealthMetric[],
  granularity: "daily" | "weekly",
) {
  const grouped = new Map<string, Array<Record<string, unknown>>>();
  for (const row of rows) {
    const date = z.string().parse(row.date);
    const key = granularity === "weekly" ? isoWeek(date) : date;
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }
  const groupedBaselines = new Map<string, DailyRecoveryBaseline[]>();
  for (const baselineRow of baselineRows) {
    const key = granularity === "weekly" ? isoWeek(baselineRow.date) : baselineRow.date;
    groupedBaselines.set(key, [...(groupedBaselines.get(key) ?? []), baselineRow]);
    if (!grouped.has(key)) grouped.set(key, [{ date: baselineRow.date }]);
  }

  return [...grouped.entries()]
    .sort(([firstKey], [secondKey]) => firstKey.localeCompare(secondKey))
    .map(([key, groupRows]) => {
      const baselineGroup = groupedBaselines.get(key) ?? [];
      const latestBaselines = latestRecoveryBaselineMetrics(baselineGroup);
      const metricValues = Object.fromEntries(
        metrics.flatMap((metric) => {
          const column = healthMetricColumns[metric];
          const recoveryMetricKey = recoveryMetricKeys[metric];
          const baselineMetric = recoveryMetricKey
            ? latestBaselines.find((candidate) => candidate.metric === recoveryMetricKey)
            : undefined;
          const baselineValues = recoveryMetricKey
            ? baselineGroup.flatMap((row) => {
                const matchingMetric = row.metrics.find(
                  (candidate) => candidate.metric === recoveryMetricKey,
                );
                return matchingMetric?.value == null ? [] : [matchingMetric.value];
              })
            : [];
          const aggregate = aggregateNumbers(
            baselineValues.length > 0
              ? baselineValues
              : groupRows.map((row) =>
                  z.coerce
                    .number()
                    .nullable()
                    .parse(column ? (row[column] ?? null) : null),
                ),
          );
          return aggregate
            ? [
                [
                  metric,
                  {
                    ...aggregate,
                    ...(baselineMetric ? { baseline_relative: baselineMetric } : {}),
                  },
                ],
              ]
            : [];
        }),
      );
      return granularity === "weekly"
        ? { week: key, metrics: metricValues }
        : { date: key, metrics: metricValues };
    });
}

function average(values: Array<number | null | undefined>): number | null {
  return aggregateNumbers(values)?.avg ?? null;
}

function activitySummaries(
  rows: ActivityMcpRow[],
  groupBy: "canonical_type" | "week" | "canonical_type_and_week",
  timezone: string,
) {
  const groups = new Map<string, ActivityMcpRow[]>();
  for (const row of rows) {
    const week = isoWeek(localDateString(new Date(row.started_at), timezone));
    const key =
      groupBy === "canonical_type"
        ? row.canonical_type
        : groupBy === "week"
          ? week
          : `${row.canonical_type}|${week}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.entries()].map(([key, groupRows]) => {
    const [activityType, week] =
      groupBy === "canonical_type_and_week" ? key.split("|") : [undefined, undefined];
    const durations = groupRows.map((row) => {
      if (!row.ended_at) return null;
      return (new Date(row.ended_at).getTime() - new Date(row.started_at).getTime()) / 60_000;
    });
    const totalDuration = durations.reduce<number>((total, duration) => total + (duration ?? 0), 0);
    return {
      ...(groupBy === "canonical_type" ? { canonical_type: key } : {}),
      ...(groupBy === "week" ? { week: key } : {}),
      ...(groupBy === "canonical_type_and_week" ? { canonical_type: activityType, week } : {}),
      count: groupRows.length,
      total_duration_minutes: totalDuration,
      avg_duration_minutes: average(durations),
      avg_hr: average(groupRows.map((row) => row.avg_hr)),
      max_hr_peak: aggregateNumbers(groupRows.map((row) => row.max_hr))?.max ?? null,
      avg_power: average(groupRows.map((row) => row.avg_power)),
      max_power_peak: aggregateNumbers(groupRows.map((row) => row.max_power))?.max ?? null,
      total_calories: null,
    };
  });
}

function validateSyncWindowTriggerInput(input: {
  sinceDays?: number;
  sinceDate?: string;
  untilDate?: string;
}): void {
  const hasSinceDate = input.sinceDate != null;
  const hasUntilDate = input.untilDate != null;
  if (hasSinceDate !== hasUntilDate) {
    throw new Error("sinceDate and untilDate must be provided together");
  }
  if (input.sinceDays != null && hasSinceDate) {
    throw new Error("sinceDays cannot be combined with sinceDate/untilDate");
  }
}

export function createDofekMcpServer(context: DofekMcpContext): McpServer {
  const server = new McpServer({
    name: "dofek",
    version: "0.1.0",
  });

  server.registerTool(
    "get_daily_health_summary",
    {
      title: "Get Daily Health Summary",
      description: "Return server-computed health metrics for one day.",
      inputSchema: {
        date: dateSchema,
        timezone: z.string().optional(),
      },
    },
    async ({ date, timezone }) => {
      requireMcpScope(context.scopes, "health:read");
      const repository = new DailyMetricsRepository(
        context.db,
        context.userId,
        timezone ?? context.timezone,
      );
      const rows = await repository.list(1, date);
      return jsonContent(rows[0] ?? null);
    },
  );

  server.registerTool(
    "get_health_trends",
    {
      title: "Get Health Trends",
      description:
        "Return daily or weekly health metric aggregates with baseline-relative recovery context for an exact date range.",
      inputSchema: {
        start_date: dateSchema,
        end_date: dateSchema,
        metrics: z.array(healthMetricSchema).optional(),
        granularity: z.enum(["daily", "weekly"]).optional(),
        timezone: z.string().optional(),
      },
    },
    async ({ start_date, end_date, metrics, granularity, timezone }) => {
      requireMcpScope(context.scopes, "health:read");
      assertDateRange(start_date, end_date);
      const requestedTimezone = timezone ?? context.timezone;
      const repository = new DailyMetricsRepository(context.db, context.userId, requestedTimezone);
      if (!context.sensorStore) {
        throw new Error("get_health_trends requires the ClickHouse analytics store");
      }
      const [restingHeartRateCte, baselineRows] = await Promise.all([
        fetchRestingHeartRateValuesCte({
          sensorStore: context.sensorStore,
          userId: context.userId,
          timezone: requestedTimezone,
          endDate: end_date,
          days: daysBetween(start_date, end_date) + 1,
        }),
        new RecoveryBaselineRepository(context.userId, context.sensorStore).listRange(
          start_date,
          end_date,
        ),
      ]);
      const rows = await repository.listRange(start_date, end_date, restingHeartRateCte);
      return jsonContent(
        healthTrends(
          rows,
          baselineRows,
          metrics ?? healthMetricSchema.options,
          granularity ?? "daily",
        ),
      );
    },
  );

  server.registerTool(
    "get_sleep_summary",
    {
      title: "Get Sleep Summary",
      description:
        "Return nightly sleep duration, efficiency, stages, and timing for a date range.",
      inputSchema: {
        start_date: dateSchema,
        end_date: dateSchema,
        timezone: z.string().optional(),
      },
    },
    async ({ start_date, end_date, timezone }) => {
      requireMcpScope(context.scopes, "health:read");
      assertDateRange(start_date, end_date);
      const requestedTimezone = timezone ?? context.timezone;
      const repository = new SleepRepository(
        context.db,
        context.userId,
        requestedTimezone,
        { kind: "full", paid: true, reason: "paid_grant" },
        context.sensorStore,
      );
      const metricsRepository = new DailyMetricsRepository(
        context.db,
        context.userId,
        requestedTimezone,
      );
      const [rows, dailyMetrics] = await Promise.all([
        repository.listRange(start_date, end_date),
        metricsRepository.listRange(start_date, end_date),
      ]);
      const respiratoryRateByDate = new Map(
        dailyMetrics.map((row) => [row.date, row.respiratory_rate_avg]),
      );
      return jsonContent(
        rows.map((row) => {
          const localTimeContext = {
            timezone: row.timezone,
            startUtcOffsetMinutes: row.start_utc_offset_minutes,
            endUtcOffsetMinutes: row.end_utc_offset_minutes,
            source: row.local_time_source,
          };
          return {
            date: row.date,
            staging_available: row.staging_available,
            total_duration_minutes: row.duration_minutes,
            sleep_efficiency_pct: row.efficiency_pct,
            time_in_bed_minutes:
              row.duration_minutes == null ? null : row.duration_minutes + (row.awake_minutes ?? 0),
            onset_time:
              formatRecordLocalTime(row.started_at, localTimeContext, "start") === "--"
                ? null
                : formatRecordLocalTime(row.started_at, localTimeContext, "start"),
            wake_time:
              row.ended_at == null ||
              formatRecordLocalTime(row.ended_at, localTimeContext, "end") === "--"
                ? null
                : formatRecordLocalTime(row.ended_at, localTimeContext, "end"),
            local_time_context: localTimeContext,
            stages: {
              rem_minutes: row.rem_minutes,
              sws_minutes: row.deep_minutes,
              light_minutes: row.light_minutes,
              awake_minutes: row.awake_minutes,
            },
            sleep_consistency_pct: null,
            respiratory_rate_avg: respiratoryRateByDate.get(row.date) ?? null,
            source_provider: row.provider_id,
          };
        }),
      );
    },
  );

  server.registerTool(
    "search_activities",
    {
      title: "Search Activities",
      description: "Search authenticated user activity summaries.",
      inputSchema: {
        from: dateSchema.optional(),
        to: dateSchema.optional(),
        query: z.string().max(200).optional(),
        limit: z.number().int().min(1).max(25).optional(),
      },
    },
    async ({ from, to, query, limit }) => {
      requireMcpScope(context.scopes, "activity:read");
      const endDate = to ?? localDateString(new Date(), context.timezone);
      const startDate = from ?? dateDaysBefore(endDate, 29);
      assertDateRange(startDate, endDate);
      const repository = new ActivityRepository(
        context.db,
        context.userId,
        context.timezone,
        { kind: "full", paid: true, reason: "paid_grant" },
        context.sensorStore,
      );
      const result = await repository.search({
        startDate,
        endDate,
        query,
        limit: limit ?? 10,
      });
      return jsonContent(result);
    },
  );

  server.registerTool(
    "get_activity_details",
    {
      title: "Get Activity Details",
      description:
        "Return one authenticated user's activity with its strength exercises and sets, climbing entries, and finger-loading details.",
      inputSchema: {
        activity_id: z.uuid(),
      },
    },
    async ({ activity_id }) => {
      requireMcpScope(context.scopes, "activity:read");
      const activityRepository = new ActivityRepository(
        context.db,
        context.userId,
        context.timezone,
        { kind: "full", paid: true, reason: "paid_grant" },
        context.sensorStore,
      );
      const activity = await activityRepository.findById(activity_id);
      if (!activity) {
        throw new Error("Activity not found.");
      }
      const [strengthExercises, climbingEntries, fingerLoading] = await Promise.all([
        new StrengthRepository(
          context.db,
          context.userId,
          context.timezone,
        ).getExercisesForActivity(activity_id),
        new ClimbingRepository(context.db, context.userId, context.timezone, {
          kind: "full",
          paid: true,
          reason: "paid_grant",
        }).getActivityEntries(activity_id),
        readFingerLoadingActivity({
          activityId: activity_id,
          database: context.db,
          userId: context.userId,
        }),
      ]);
      return jsonContent({
        activity,
        climbing_entries: climbingEntries.map((entry) => entry.toDetail()),
        finger_loading: fingerLoading,
        strength_exercises: strengthExercises.map((exercise) => exercise.toDetail()),
      });
    },
  );

  server.registerTool(
    "get_activity_summary",
    {
      title: "Get Activity Summary",
      description: "Aggregate activity volume and effort over an exact date range.",
      inputSchema: {
        start_date: dateSchema,
        end_date: dateSchema,
        group_by: z.enum(["canonical_type", "week", "canonical_type_and_week"]).optional(),
        canonical_types: z.array(z.string()).optional(),
      },
    },
    async ({ start_date, end_date, group_by, canonical_types }) => {
      requireMcpScope(context.scopes, "activity:read");
      assertDateRange(start_date, end_date);
      const repository = new ActivityRepository(
        context.db,
        context.userId,
        context.timezone,
        { kind: "full", paid: true, reason: "paid_grant" },
        context.sensorStore,
      );
      const rows = await repository.listRange(start_date, end_date, canonical_types);
      return jsonContent(
        activitySummaries(
          rows.map((row) => activityMcpRowSchema.parse(row)),
          group_by ?? "canonical_type",
          context.timezone,
        ),
      );
    },
  );

  server.registerTool(
    "get_finger_loading",
    {
      title: "Get Finger Loading",
      description:
        "Return structured finger-loading protocols and server-computed effective load for an exact date range.",
      inputSchema: {
        start_date: dateSchema,
        end_date: dateSchema,
        timezone: z.string().optional(),
      },
    },
    async ({ start_date, end_date, timezone }) => {
      requireMcpScope(context.scopes, "activity:read");
      assertDateRange(start_date, end_date);
      const rows = await readFingerLoadingRange({
        database: context.db,
        endDate: end_date,
        startDate: start_date,
        timezone: timezone ?? context.timezone,
        userId: context.userId,
      });
      return jsonContent(
        rows.map((row) => ({
          activity_id: row.activityId,
          bodyweight_kg: row.bodyweightKg,
          edge_size_mm: row.edgeSizeMm,
          effective_load_kg: row.effectiveLoadKg,
          exercise: row.exercise,
          external_load_kg: row.externalLoadKg,
          grip_position: row.gripPosition,
          hold_duration_seconds: row.holdDurationSeconds,
          laterality: row.laterality,
          notes: row.notes,
          rest_interval_seconds: row.restIntervalSeconds,
          rpe: row.rpe,
          set_count: row.setCount,
          started_at: row.startedAt,
        })),
      );
    },
  );

  server.registerTool(
    "get_nutrition_summary",
    {
      title: "Get Nutrition Summary",
      description: "Return daily calorie, macronutrient, fiber, and meal totals for a date range.",
      inputSchema: {
        start_date: dateSchema,
        end_date: dateSchema,
        timezone: z.string().optional(),
      },
    },
    async ({ start_date, end_date, timezone }) => {
      requireMcpScope(context.scopes, "nutrition:read");
      assertDateRange(start_date, end_date);
      const repository = new FoodRepository(
        context.db,
        context.userId,
        timezone ?? context.timezone,
      );
      const rows = await repository.dailyTotalsRange(start_date, end_date);
      return jsonContent(
        rows.map((row) => ({
          date: row.date,
          total_calories: row.calories,
          protein_g: row.proteinGrams,
          carbs_g: row.carbsGrams,
          fat_g: row.fatGrams,
          fiber_g: row.fiberGrams,
          meal_count: row.mealCount,
          resolution_status: row.resolutionStatus,
          resolution_message: row.resolutionMessage,
          source_provider:
            row.contributingProviders.length === 1 ? row.contributingProviders[0] : null,
          source_providers: row.sourceProviders,
          contributing_providers: row.contributingProviders,
          excluded_providers: row.excludedProviders,
        })),
      );
    },
  );

  server.registerTool(
    "get_body_metrics",
    {
      title: "Get Body Metrics",
      description: "Return weight and body-composition measurements for an exact date range.",
      inputSchema: {
        start_date: dateSchema,
        end_date: dateSchema,
      },
    },
    async ({ start_date, end_date }) => {
      requireMcpScope(context.scopes, "health:read");
      assertDateRange(start_date, end_date);
      if (!context.sensorStore) {
        throw new Error("get_body_metrics requires the ClickHouse analytics store");
      }
      const repository = new BodyRepository(context.sensorStore, context.userId, context.timezone);
      const rows = await repository.listRange(start_date, end_date);
      return jsonContent(
        rows.map((row) => ({
          date: localDateString(new Date(row.recordedAt), context.timezone),
          weight_kg: row.weightKg,
          body_fat_pct: row.bodyFatPct,
          lean_mass_kg:
            row.weightKg != null && row.bodyFatPct != null
              ? row.weightKg * (1 - row.bodyFatPct / 100)
              : null,
          bmi: row.bmi,
          source_provider: row.providerId,
        })),
      );
    },
  );

  server.registerTool(
    "get_subjective_timeline",
    {
      title: "Get Subjective Timeline",
      description: "Return raw subjective check-ins, symptoms, and injury events for a date range.",
      inputSchema: {
        start_date: dateSchema,
        end_date: dateSchema,
      },
    },
    async ({ start_date, end_date }) => {
      requireMcpScope(context.scopes, "health:read");
      assertDateRange(start_date, end_date);
      const repository = new SubjectiveRepository(context.db, context.userId, context.timezone);
      return jsonContent(await repository.timeline(start_date, end_date));
    },
  );

  server.registerTool(
    "list_providers",
    {
      title: "List Providers",
      description: "List configured user-facing providers and connection status.",
      inputSchema: {},
    },
    async () => {
      requireMcpScope(context.scopes, "providers:read");
      await ensureProvidersRegistered();
      const repository = new SyncRepository(context.db, context.userId);
      const [connectedProviders, lastSyncs, latestErrors] = await Promise.all([
        repository.getConnectedProviderIds(),
        repository.getLastSyncTimes(),
        repository.getLatestErrors(),
      ]);
      const connectedProviderIds = new Set(
        connectedProviders.map((provider) => provider.providerId),
      );
      const tokenUpdatedAtMap = new Map(
        connectedProviders.map((provider) => [provider.providerId, provider.updatedAt]),
      );
      const lastSyncMap = new Map(
        lastSyncs.map((provider) => [provider.providerId, provider.lastSynced]),
      );
      const authErrorProviderIds = new Set(
        latestErrors
          .filter((provider) =>
            hasCurrentProviderAuthFailure(
              provider.authFailureReason,
              provider.syncedAt,
              tokenUpdatedAtMap.get(provider.providerId),
            ),
          )
          .map((provider) => provider.providerId),
      );

      const providers = getAllProviders()
        .filter((provider) => provider.validate() === null)
        .map((provider) => {
          const model = new ProviderModel(
            provider,
            connectedProviderIds,
            lastSyncMap,
            CUSTOM_AUTH_PROVIDERS,
          );
          return {
            id: model.id,
            name: model.name,
            authType: model.authType,
            authorized: model.isConnected,
            lastSyncedAt: model.lastSyncedAt,
            importOnly: model.importOnly,
            needsReauth: model.isConnected && authErrorProviderIds.has(model.id),
          };
        });
      return jsonContent(providers);
    },
  );

  server.registerTool(
    "start_provider_sync",
    {
      title: "Start Provider Sync",
      description: "Enqueue a user-scoped provider sync job.",
      inputSchema: {
        providerId: z.string().min(1),
        sinceDays: z.number().int().positive().optional(),
        sinceDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
        untilDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
      },
    },
    async ({ providerId, sinceDays, sinceDate, untilDate }) => {
      requireMcpScope(context.scopes, "sync:write");
      await ensureProvidersRegistered();
      const provider = getAllProviders().find((candidate) => candidate.id === providerId);
      if (!provider) {
        throw new Error(`Unknown provider: ${providerId}`);
      }
      const validationMessage = provider.validate();
      if (validationMessage) {
        throw new Error(`Provider not configured: ${validationMessage}`);
      }
      validateSyncWindowTriggerInput({ sinceDays, sinceDate, untilDate });
      const syncWindow = syncWindowFromTriggerInput({
        sinceDays,
        sinceDate,
        untilDate,
      });
      const job = await withAccountErasureUserWriteFence(context.db, context.userId, async () =>
        enqueueSyncJob(
          providerId,
          {
            providerId,
            userId: context.userId,
            ...syncWindowToJobData(syncWindow, sinceDays),
          },
          { skipWhenRateLimited: true },
        ),
      );
      if (!job) {
        throw new Error(`Provider ${providerId} sync skipped: rate-limit cooldown active`);
      }
      return jsonContent({
        providerId,
        jobId: toJobId(job.id, providerId),
        queueName: providerSyncQueueName(providerId),
        status: "queued",
      });
    },
  );

  return server;
}
