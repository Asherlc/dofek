import { formatRecordLocalTime } from "@dofek/format/record-local-time";
import { CANONICAL_ACTIVITY_TYPES } from "@dofek/training/activity-types";
import { McpServer } from "@modelcontextprotocol/server";
import { withAccountErasureUserWriteFence } from "dofek/db/account-erasure";
import { enqueueSyncJob } from "dofek/jobs/enqueue-sync-job";
import {
  providerRateLimitCooldownStore,
  providerSyncDeferralMessage,
} from "dofek/jobs/provider-rate-limit-cooldown";
import { providerSyncQueueName } from "dofek/jobs/queues";
import { syncJobDataFromTriggerInput } from "dofek/jobs/sync-window";
import { providerRequiresStoredTokens } from "dofek/lib/custom-auth-providers";
import { captureException } from "dofek/lib/error-reporting";
import { getAllProviders } from "dofek/providers/registry";
import { z } from "zod";
import { dateSchema } from "../lib/date-schema.ts";
import { ActivityRepository } from "../repositories/activity-repository.ts";
import { BodyRepository } from "../repositories/body-repository.ts";
import { readFingerLoadingRange } from "../repositories/climbing-training-log-repository.ts";
import { DailyMetricsRepository } from "../repositories/daily-metrics-repository.ts";
import { DataCoverageRepository } from "../repositories/data-coverage-repository.ts";
import { FoodRepository } from "../repositories/food-repository.ts";
import { localDateString } from "../repositories/resting-heart-rate-query.ts";
import {
  analysisTimezoneSchema,
  listSleepEpisodes,
} from "../repositories/sleep-episode-analysis.ts";
import { SyncRepository } from "../repositories/sync-repository.ts";
import { ensureProvidersRegistered, toJobId } from "../routers/sync-helpers.ts";
import { registerActivityDetailsTool } from "./activity-details-tool.ts";
import { registerActivityStreamsTool } from "./activity-streams-tool.ts";
import { registerActivityTimeseriesTool } from "./activity-timeseries-tool.ts";
import { registerDofekAppResources } from "./app-resource.ts";
import { registerAuthorizedTool } from "./authorized-tool.ts";
import { registerClimbingCatalogueTool } from "./climbing-catalogue-tool.ts";
import { registerClimbingProgressionTool } from "./climbing-progression-tool.ts";
import { registerClimbingSessionsTool } from "./climbing-sessions-tool.ts";
import type { DofekMcpContext } from "./context.ts";
import { registerCyclingPerformanceTool } from "./cycling-performance-tool.ts";
import { registerCyclingPowerCurveTool } from "./cycling-power-curve-tool.ts";
import { registerCyclingPowerProfileTool } from "./cycling-power-profile-tool.ts";
import { registerCyclingTrainingMetricsTool } from "./cycling-training-metrics-tool.ts";
import { registerEffortTrendTool } from "./effort-trend-tool.ts";
import { registerFingerLoadingProgressionTool } from "./finger-loading-progression-tool.ts";
import { registerFoodRecordTools } from "./food-record-tools.ts";
import { registerHealthTrendTools } from "./health-trend-tools.ts";
import {
  assertNutritionSummaryDateRange,
  toNutritionSummaryOutput,
} from "./nutrition-summary-output.ts";
import { registerPerformanceComparisonTool } from "./performance-comparison-tool.ts";
import { listProviderStatuses } from "./provider-status.ts";
import { registerRecoveryTrainingSeriesTool } from "./recovery-training-series-tool.ts";
import { registerRepeatedEffortsTool } from "./repeated-efforts-tool.ts";
import { registerStrengthProgressionTool } from "./strength-progression-tool.ts";
import { registerStrengthSessionsTool } from "./strength-sessions-tool.ts";
import { requireMcpScope } from "./token-repository.ts";
import { aggregateNumbers, isoWeek } from "./tool-aggregation.ts";
import { mcpOutputSchemas } from "./tool-output.ts";
import { jsonToolResult } from "./tool-result.ts";
import { assertDateRange } from "./tool-utils.ts";
import { registerTrainingLoadTool } from "./training-load-tool.ts";

export type { DofekMcpContext } from "./context.ts";

const activityMcpRowSchema = z.object({
  canonical_type: z.string(),
  provider_type: z.string().optional().default(""),
  started_at: z.string(),
  ended_at: z.string().nullable(),
  avg_hr: z.coerce.number().nullable().optional(),
  max_hr: z.coerce.number().nullable().optional(),
  avg_power: z.coerce.number().nullable().optional(),
  max_power: z.coerce.number().nullable().optional(),
  elevation_gain_m: z.coerce.number().nullable().optional(),
  modality: z.string().nullable().optional(),
});
type ActivityMcpRow = z.infer<typeof activityMcpRowSchema>;
function dateDaysBefore(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - days);
  return value.toISOString().slice(0, 10);
}

function average(values: Array<number | null | undefined>): number | null {
  return aggregateNumbers(values)?.avg ?? null;
}
const powerModalities = ["indoor", "outdoor", "unknown"] as const;
function summarizePower(rows: ActivityMcpRow[]) {
  const poweredRows = rows.filter((row) => row.avg_power != null);
  const coverage = {
    activities_with_power: poweredRows.length,
    activities_total: rows.length,
    pct: rows.length === 0 ? 0 : (poweredRows.length / rows.length) * 100,
  };
  if (poweredRows.length < 3) {
    return { avg_power: null, max_power_peak: null, ...coverage };
  }
  return {
    avg_power: average(poweredRows.map((row) => row.avg_power)),
    max_power_peak: aggregateNumbers(poweredRows.map((row) => row.max_power))?.max ?? null,
    ...coverage,
  };
}

function powerByModality(rows: ActivityMcpRow[]) {
  const rowsFor = (modality: (typeof powerModalities)[number]) =>
    rows.filter((row) =>
      modality === "unknown"
        ? row.modality !== "indoor" && row.modality !== "outdoor"
        : row.modality === modality,
    );
  return {
    indoor: summarizePower(rowsFor("indoor")),
    outdoor: summarizePower(rowsFor("outdoor")),
    unknown: summarizePower(rowsFor("unknown")),
  };
}

function activityPurpose(row: ActivityMcpRow): "commute" | "training" | null {
  if (row.canonical_type !== "cycling") return null;
  const rawType = row.provider_type.trim().toLowerCase();
  return rawType === "89" || rawType === "commute" || rawType === "commuting"
    ? "commute"
    : "training";
}

function activitySummaries(
  rows: ActivityMcpRow[],
  groupBy:
    | "canonical_type"
    | "week"
    | "canonical_type_and_week"
    | "canonical_type_and_modality"
    | "canonical_type_and_purpose",
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
          : groupBy === "canonical_type_and_week"
            ? `${row.canonical_type}|${week}`
            : groupBy === "canonical_type_and_modality"
              ? `${row.canonical_type}|${row.modality ?? ""}`
              : `${row.canonical_type}|${activityPurpose(row) ?? ""}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.entries()]
    .sort(([first], [second]) => first.localeCompare(second))
    .map(([key, groupRows]) => {
      const [activityType, week] =
        groupBy === "canonical_type_and_week" ? key.split("|") : [undefined, undefined];
      const [modalityActivityType, modality] =
        groupBy === "canonical_type_and_modality" ? key.split("|") : [undefined, undefined];
      const [purposeActivityType, purpose] =
        groupBy === "canonical_type_and_purpose" ? key.split("|") : [undefined, undefined];
      const durations = groupRows.map((row) => {
        if (!row.ended_at) return null;
        return (new Date(row.ended_at).getTime() - new Date(row.started_at).getTime()) / 60_000;
      });
      const totalDuration = durations.reduce<number>(
        (total, duration) => total + (duration ?? 0),
        0,
      );
      const elevations = groupRows.map((row) => row.elevation_gain_m);
      const observedElevations = elevations.filter((value): value is number => value != null);
      const totalElevationGain =
        observedElevations.length === 0
          ? null
          : observedElevations.reduce((total, elevation) => total + elevation, 0);
      return {
        ...(groupBy === "canonical_type" ? { canonical_type: key } : {}),
        ...(groupBy === "week" ? { week: key } : {}),
        ...(groupBy === "canonical_type_and_week" ? { canonical_type: activityType, week } : {}),
        ...(groupBy === "canonical_type_and_modality"
          ? { canonical_type: modalityActivityType, modality: modality || null }
          : {}),
        ...(groupBy === "canonical_type_and_purpose"
          ? { canonical_type: purposeActivityType, purpose: purpose || null }
          : {}),
        count: groupRows.length,
        total_duration_minutes: totalDuration,
        avg_duration_minutes: average(durations),
        avg_hr: average(groupRows.map((row) => row.avg_hr)),
        max_hr_peak: aggregateNumbers(groupRows.map((row) => row.max_hr))?.max ?? null,
        power_by_modality: powerByModality(groupRows),
        total_elevation_gain_m: totalElevationGain,
        avg_elevation_gain_m: average(elevations),
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
  registerDofekAppResources(server);
  registerHealthTrendTools(server, context);
  registerAuthorizedTool(
    server,
    ["health:read"],
    "get_daily_health_summary",
    {
      title: "Get Daily Health Summary",
      description: "Return server-computed health metrics for one day.",
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      inputSchema: z.object({
        date: dateSchema,
        timezone: z.string().optional(),
      }),
      outputSchema: mcpOutputSchemas.dailyHealthSummary,
    },
    async ({ date, timezone }) => {
      requireMcpScope(context.scopes, "health:read");
      if (!context.sensorStore) {
        throw new Error("get_daily_health_summary requires the ClickHouse analytics store");
      }
      const repository = new DailyMetricsRepository(
        context.db,
        context.userId,
        timezone ?? context.timezone,
        context.sensorStore,
      );
      const rows = await repository.list(1, date);
      return jsonToolResult(rows[0] ?? null);
    },
  );
  registerAuthorizedTool(
    server,
    ["health:read"],
    "get_data_coverage",
    {
      title: "Get Data Coverage",
      description:
        "Return first and last observed dates, observed-day counts, and source providers for every health metric.",
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      inputSchema: z.object({}),
      outputSchema: mcpOutputSchemas.dataCoverage,
    },
    async () => {
      requireMcpScope(context.scopes, "health:read");
      if (!context.sensorStore) {
        throw new Error("get_data_coverage requires the ClickHouse analytics store");
      }
      return jsonToolResult(
        await new DataCoverageRepository(
          context.sensorStore,
          context.userId,
          context.timezone,
        ).list(),
      );
    },
  );
  registerTrainingLoadTool(server, context);
  registerRecoveryTrainingSeriesTool(server, context);
  registerRepeatedEffortsTool(server, context);
  registerPerformanceComparisonTool(server, context);
  registerEffortTrendTool(server, context);
  registerCyclingPerformanceTool(server, context);
  registerCyclingPowerCurveTool(server, context);
  registerCyclingPowerProfileTool(server, context);
  registerCyclingTrainingMetricsTool(server, context);
  registerActivityStreamsTool(server, context);
  registerActivityTimeseriesTool(server, context);
  registerActivityDetailsTool(server, context);
  registerClimbingProgressionTool(server, context);
  registerFingerLoadingProgressionTool(server, context);
  registerStrengthProgressionTool(server, context);
  registerClimbingSessionsTool(server, context);
  registerClimbingCatalogueTool(server, context);
  registerStrengthSessionsTool(server, context);
  registerFoodRecordTools(server, context);
  registerAuthorizedTool(
    server,
    ["health:read"],
    "get_sleep_summary",
    {
      title: "Get Sleep Summary",
      description:
        "Summarize sleep episodes by local wake date, with original UTC times, stages, and source records. An explicit timezone uses that IANA zone for both endpoints.",
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      inputSchema: z.object({
        start_date: dateSchema,
        end_date: dateSchema,
        timezone: analysisTimezoneSchema.optional(),
        providers: z.array(z.string().min(1)).max(20).optional(),
        include_naps: z.boolean().optional(),
      }),
      outputSchema: mcpOutputSchemas.sleepSummary,
    },
    async ({ start_date, end_date, timezone, providers, include_naps }) => {
      requireMcpScope(context.scopes, "health:read");
      assertDateRange(start_date, end_date);
      const requestedTimezone = timezone ?? context.timezone;
      if (!context.sensorStore) {
        throw new Error("get_sleep_summary requires the ClickHouse analytics store");
      }
      const metricsRepository = new DailyMetricsRepository(
        context.db,
        context.userId,
        requestedTimezone,
        context.sensorStore,
      );
      const [rows, dailyMetrics] = await Promise.all([
        listSleepEpisodes(context.sensorStore, {
          userId: context.userId,
          startDate: start_date,
          endDate: end_date,
          profileTimezone: context.timezone,
          analysisTimezone: timezone,
          providers,
          includeNaps: include_naps,
        }),
        metricsRepository.listRange(start_date, end_date),
      ]);
      const respiratoryRateByDate = new Map(
        dailyMetrics.map((row) => [row.date, row.respiratory_rate_avg]),
      );
      return jsonToolResult(
        rows.map((row) => {
          const localTimeContext = {
            ...row.timing.local_time_context,
            timezone: row.timing.display_timezone,
          };
          const onsetTime = formatRecordLocalTime(
            row.timing.started_at,
            localTimeContext,
            "start",
            undefined,
            requestedTimezone,
          );
          const wakeTime =
            row.timing.ended_at == null
              ? "--"
              : formatRecordLocalTime(
                  row.timing.ended_at,
                  localTimeContext,
                  "end",
                  undefined,
                  requestedTimezone,
                );
          return {
            ...row.timing,
            date: row.date,
            staging_available: row.staging_available,
            total_duration_minutes: row.duration_minutes,
            sleep_efficiency_pct: row.efficiency_pct,
            time_in_bed_minutes:
              row.duration_minutes == null || row.stages_minutes.awake == null
                ? null
                : row.duration_minutes + row.stages_minutes.awake,
            onset_time: onsetTime === "--" ? null : onsetTime,
            wake_time: wakeTime === "--" ? null : wakeTime,
            stages: {
              rem_minutes: row.stages_minutes.rem,
              sws_minutes: row.stages_minutes.deep,
              light_minutes: row.stages_minutes.light,
              awake_minutes: row.stages_minutes.awake,
            },
            sleep_consistency_pct: null,
            respiratory_rate_avg: respiratoryRateByDate.get(row.date) ?? null,
          };
        }),
      );
    },
  );
  registerAuthorizedTool(
    server,
    ["activity:read"],
    "search_activities",
    {
      title: "Search Activities",
      description:
        "Page through authenticated user activities in an optional date range (defaulting to the last 30 days), with text, provider and type filters.",
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      inputSchema: z.object({
        from: dateSchema.optional(),
        to: dateSchema.optional(),
        timezone: analysisTimezoneSchema.optional(),
        query: z.string().max(200).optional(),
        include: z.array(z.literal("mapPreview")).optional(),
        limit: z.number().int().min(1).max(25).optional(),
        cursor: z.string().uuid().optional(),
        detail: z.literal("compact").optional(),
        provider: z.string().min(1).max(200).optional(),
        canonical_type: z.enum(CANONICAL_ACTIVITY_TYPES).optional(),
      }),
      outputSchema: mcpOutputSchemas.searchActivities,
    },
    async ({
      from,
      to,
      timezone,
      query,
      include,
      limit,
      cursor,
      detail,
      provider,
      canonical_type,
    }) => {
      requireMcpScope(context.scopes, "activity:read");
      const analysisZone = timezone ?? context.timezone;
      const endDate = to ?? localDateString(new Date(), analysisZone);
      const startDate = from ?? dateDaysBefore(endDate, 29);
      assertDateRange(startDate, endDate);
      const repository = new ActivityRepository(
        context.db,
        context.userId,
        analysisZone,
        { kind: "full", paid: true, reason: "paid_grant" },
        context.sensorStore,
      );
      const resultLimit = limit ?? 10;
      const compact = detail === "compact";
      let result: Awaited<ReturnType<ActivityRepository["search"]>>;
      try {
        result = await repository.search({
          startDate,
          endDate,
          query,
          limit: resultLimit,
          ...(cursor && { cursor }),
          ...(compact && { compact }),
          ...(provider && { provider }),
          ...(canonical_type && { canonicalType: canonical_type }),
        });
      } catch (error: unknown) {
        captureException(error, {
          tags: { mcp_tool: "search_activities" },
          extra: {
            startDate,
            endDate,
            hasQuery: query !== undefined,
            limit: resultLimit,
          },
        });
        throw error;
      }
      const nextCursor = result.nextCursor ?? null;
      if (compact) {
        return jsonToolResult({
          items: result.items.map((item) => ({
            id: item.id,
            canonical_type: item.canonical_type,
            started_at: item.started_at,
            ended_at: item.ended_at,
            source_providers: item.source_providers,
          })),
          totalCount: result.totalCount,
          next_cursor: nextCursor,
        });
      }
      if (include?.includes("mapPreview")) {
        return jsonToolResult({
          items: result.items,
          totalCount: result.totalCount,
          next_cursor: nextCursor,
        });
      }
      return jsonToolResult({
        totalCount: result.totalCount,
        next_cursor: nextCursor,
        items: result.items.map((item) => {
          const location = item.location;
          if (typeof location !== "object" || location === null || !("mapPreview" in location)) {
            return item;
          }
          const { mapPreview: _mapPreview, ...locationWithoutPreview } = location;
          return { ...item, location: locationWithoutPreview };
        }),
      });
    },
  );
  registerAuthorizedTool(
    server,
    ["activity:read"],
    "get_activity_summary",
    {
      title: "Get Activity Summary",
      description: "Aggregate activity volume and effort over an exact date range.",
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      inputSchema: z.object({
        start_date: dateSchema,
        end_date: dateSchema,
        group_by: z
          .enum([
            "canonical_type",
            "week",
            "canonical_type_and_week",
            "canonical_type_and_modality",
            "canonical_type_and_purpose",
          ])
          .optional(),
        canonical_types: z.array(z.string()).optional(),
      }),
      outputSchema: mcpOutputSchemas.activitySummary,
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
      const parsedRows = rows.map((row) => activityMcpRowSchema.parse(row));
      const unclassifiedCount = parsedRows.filter((row) => row.canonical_type === "other").length;
      return jsonToolResult({
        unclassified_pct:
          parsedRows.length === 0 ? 0 : (unclassifiedCount / parsedRows.length) * 100,
        summaries: activitySummaries(parsedRows, group_by ?? "canonical_type", context.timezone),
      });
    },
  );
  registerAuthorizedTool(
    server,
    ["activity:read"],
    "get_finger_loading",
    {
      title: "Get Finger Loading",
      description:
        "Return structured finger-loading protocols and server-computed effective load for an exact date range.",
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      inputSchema: z.object({
        start_date: dateSchema,
        end_date: dateSchema,
        timezone: z.string().optional(),
      }),
      outputSchema: mcpOutputSchemas.fingerLoading,
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
      return jsonToolResult(
        rows.map((row) => ({
          activity_id: row.activityId,
          bodyweight_kg: row.bodyweightKg,
          edge_size_mm: row.edgeSizeMm,
          effective_load_kg: row.effectiveLoadKg,
          effective_load_formula: "bodyweight_kg + external_load_kg",
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
          total_time_under_tension_seconds: null,
          total_time_under_tension_status: "unavailable" as const,
          total_time_under_tension_reason:
            "Exact time under tension requires repetitions per set, which the canonical source schema does not record.",
        })),
      );
    },
  );
  registerAuthorizedTool(
    server,
    ["nutrition:read"],
    "get_nutrition_summary",
    {
      title: "Get Nutrition Summary",
      description:
        "Return a complete daily date spine of calorie, macronutrient, fiber, and meal totals with source resolution and conservative logging-completeness status. Missing nutrition stays null.",
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      inputSchema: z.object({
        start_date: dateSchema,
        end_date: dateSchema,
        timezone: z.string().optional(),
      }),
      outputSchema: mcpOutputSchemas.nutritionSummary,
    },
    async ({ start_date, end_date, timezone }) => {
      requireMcpScope(context.scopes, "nutrition:read");
      assertDateRange(start_date, end_date);
      assertNutritionSummaryDateRange(start_date, end_date);
      const repository = new FoodRepository(
        context.db,
        context.userId,
        timezone ?? context.timezone,
      );
      const rows = await repository.dailyTotalsRange(start_date, end_date);
      return jsonToolResult(rows.map(toNutritionSummaryOutput));
    },
  );
  registerAuthorizedTool(
    server,
    ["health:read"],
    "get_body_metrics",
    {
      title: "Get Body Metrics",
      description:
        "Return reconciled weight and body-composition measurements, explicit value kinds, source provenance, and 7/28-day rolling weight statistics for an exact date range.",
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      inputSchema: z.object({
        start_date: dateSchema,
        end_date: dateSchema,
      }),
      outputSchema: mcpOutputSchemas.bodyMetrics,
    },
    async ({ start_date, end_date }) => {
      requireMcpScope(context.scopes, "health:read");
      assertDateRange(start_date, end_date);
      if (!context.sensorStore) {
        throw new Error("get_body_metrics requires the ClickHouse analytics store");
      }
      const repository = new BodyRepository(context.sensorStore, context.userId, context.timezone);
      const rows = await repository.listReconciledRange(start_date, end_date);
      return jsonToolResult(
        rows.map((row) => ({
          date: row.date,
          weight_kg: row.weightKg,
          weight_measurement_kind: row.weightMeasurementKind,
          body_fat_pct: row.bodyFatPct,
          body_fat_measurement_kind: row.bodyFatMeasurementKind,
          lean_mass_kg: row.leanMassKg,
          lean_mass_measurement_kind: row.leanMassMeasurementKind,
          bmi: row.bmi,
          weight_rolling: {
            average_7d_kg: row.weightRolling.average7dKg,
            average_28d_kg: row.weightRolling.average28dKg,
            observed_days_7d: row.weightRolling.observedDays7d,
            observed_days_28d: row.weightRolling.observedDays28d,
          },
          source_provider_by_metric: {
            weight_kg: row.sourceProviderByMetric.weightKg,
            body_fat_pct: row.sourceProviderByMetric.bodyFatPct,
            bmi: row.sourceProviderByMetric.bmi,
          },
          sources: row.sources.map((source) => ({
            source_provider: source.sourceProvider,
            recorded_at: source.recordedAt,
            weight_kg: source.weightKg,
            body_fat_pct: source.bodyFatPct,
            bmi: source.bmi,
          })),
          coverage: { source_count: row.coverage.sourceCount },
        })),
      );
    },
  );
  registerAuthorizedTool(
    server,
    ["providers:read"],
    "list_providers",
    {
      title: "List Providers",
      description:
        "List configured Dofek providers with connection status and last-sync timestamps.",
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      inputSchema: z.object({}),
      outputSchema: mcpOutputSchemas.providers,
    },
    async () => {
      requireMcpScope(context.scopes, "providers:read");
      return jsonToolResult(await listProviderStatuses(context));
    },
  );
  registerAuthorizedTool(
    server,
    ["sync:write"],
    "start_provider_sync",
    {
      title: "Start Provider Sync",
      description: "Enqueue a user-scoped provider sync job.",
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
      inputSchema: z.object({
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
      }),
      outputSchema: mcpOutputSchemas.providerSync,
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
      if (providerRequiresStoredTokens(provider)) {
        const connections = await new SyncRepository(
          context.db,
          context.userId,
        ).getConnectedProviderIds();
        const hasTokens = connections.some(
          (connection) => connection.providerId === providerId && connection.hasTokens,
        );
        if (!hasTokens) {
          throw new Error(`Provider not connected: ${providerId}`);
        }
      }
      validateSyncWindowTriggerInput({ sinceDays, sinceDate, untilDate });
      const syncJobWindow = syncJobDataFromTriggerInput({
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
            origin: "manual",
            ...syncJobWindow,
          },
          { skipWhenRateLimited: true },
        ),
      );
      if (!job) {
        throw new Error(
          providerSyncDeferralMessage(
            await providerRateLimitCooldownStore.getActive(providerId, context.userId),
          ),
        );
      }
      return jsonToolResult({
        providerId,
        jobId: toJobId(job.id, providerId),
        queueName: providerSyncQueueName(providerId),
        status: "queued",
      });
    },
  );
  return server;
}
