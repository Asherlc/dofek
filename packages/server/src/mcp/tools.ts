import { formatRecordLocalTime } from "@dofek/format/record-local-time";
import {
  type HealthExplorerInput,
  type HealthMetric,
  healthExplorerInputSchema,
  healthExplorerSnapshotSchema,
  healthMetricSchema,
} from "@dofek/mcp-contracts/health-explorer";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withAccountErasureUserWriteFence } from "dofek/db/account-erasure";
import { enqueueSyncJob } from "dofek/jobs/enqueue-sync-job";
import { providerSyncQueueName } from "dofek/jobs/queues";
import { syncWindowFromTriggerInput, syncWindowToJobData } from "dofek/jobs/sync-window";
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
import { SubjectiveRepository } from "../repositories/subjective-repository.ts";
import { SyncRepository } from "../repositories/sync-repository.ts";
import { ensureProvidersRegistered, toJobId } from "../routers/sync-helpers.ts";
import { registerActivityDetailsTool } from "./activity-details-tool.ts";
import { registerActivityStreamsTool } from "./activity-streams-tool.ts";
import { healthExplorerResourceUri, registerDofekAppResources } from "./app-resource.ts";
import { registerClimbingSessionsTool } from "./climbing-sessions-tool.ts";
import type { DofekMcpContext } from "./context.ts";
import { registerCyclingPerformanceTool } from "./cycling-performance-tool.ts";
import { HealthExplorerService } from "./health-explorer-service.ts";
import { buildHealthSeries, type HealthTrendRow } from "./health-series-service.ts";
import { listProviderStatuses } from "./provider-status.ts";
import { registerStrengthSessionsTool } from "./strength-sessions-tool.ts";
import { registerSupplementsTool } from "./supplements-tool.ts";
import { requireMcpScope } from "./token-repository.ts";
import { mcpOutputSchemas } from "./tool-output.ts";
import { jsonToolResult } from "./tool-result.ts";
import { assertDateRange } from "./tool-utils.ts";
import { registerTrainingLoadTool } from "./training-load-tool.ts";

export type { DofekMcpContext } from "./context.ts";

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
): HealthTrendRow[] {
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
          const datedValues =
            baselineValues.length > 0
              ? baselineGroup.map((row) => {
                  const matchingMetric = row.metrics.find(
                    (candidate) => candidate.metric === recoveryMetricKey,
                  );
                  return { date: row.date, value: matchingMetric?.value ?? null };
                })
              : groupRows.map((row) => ({
                  date: z.string().parse(row.date),
                  value: z.coerce
                    .number()
                    .nullable()
                    .parse(column ? (row[column] ?? null) : null),
                }));
          const aggregate = aggregateNumbers(datedValues.map(({ value }) => value));
          return aggregate
            ? [
                [
                  metric,
                  {
                    ...aggregate,
                    observed_dates: datedValues.flatMap(({ date, value }) =>
                      value == null ? [] : [date],
                    ),
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

async function listHealthTrends(
  context: DofekMcpContext,
  input: HealthExplorerInput,
): Promise<HealthTrendRow[]> {
  assertDateRange(input.start_date, input.end_date);
  const requestedTimezone = input.timezone ?? context.timezone;
  const repository = new DailyMetricsRepository(context.db, context.userId, requestedTimezone);
  if (!context.sensorStore) {
    throw new Error("get_health_trends requires the ClickHouse analytics store");
  }
  const [restingHeartRateCte, baselineRows] = await Promise.all([
    fetchRestingHeartRateValuesCte({
      sensorStore: context.sensorStore,
      userId: context.userId,
      timezone: requestedTimezone,
      endDate: input.end_date,
      days: daysBetween(input.start_date, input.end_date) + 1,
    }),
    new RecoveryBaselineRepository(context.userId, context.sensorStore).listRange(
      input.start_date,
      input.end_date,
    ),
  ]);
  const rows = await repository.listRange(input.start_date, input.end_date, restingHeartRateCte);
  return healthTrends(rows, baselineRows, input.metrics, input.granularity);
}

async function healthTrendsResponse(
  context: DofekMcpContext,
  series: HealthTrendRow[],
  input: HealthExplorerInput,
  timezone: string,
): Promise<ReturnType<typeof healthTrendsEnvelope>> {
  if (!context.sensorStore) {
    throw new Error("get_health_trends requires the ClickHouse analytics store");
  }
  const coverage = await new DataCoverageRepository(
    context.sensorStore,
    context.userId,
    timezone,
  ).list();
  const requestedMetricSet = new Set(input.metrics);
  const firstAvailableDates = coverage.flatMap((row) =>
    requestedMetricSet.has(row.metric) && row.first_observed ? [row.first_observed] : [],
  );
  return healthTrendsEnvelope(series, input, timezone, firstAvailableDates);
}

function healthTrendsEnvelope(
  rows: HealthTrendRow[],
  input: HealthExplorerInput,
  timezone: string,
  firstAvailableDates: string[],
) {
  const built = buildHealthSeries(rows, input);
  const observedSeries = built.series.filter((item) => item.note == null);
  const availableDates = observedSeries.flatMap((item) =>
    item.points.flatMap((point) => (/^\d{4}-\d{2}-\d{2}$/.test(point.key) ? [point.key] : [])),
  );
  const earliestAvailable = [...availableDates, ...firstAvailableDates].sort()[0] ?? null;

  return {
    range: {
      start_date: input.start_date,
      end_date: input.end_date,
      granularity: input.granularity,
      timezone,
    },
    requested_metrics: input.metrics,
    series: built.series,
    diagnostics: {
      metrics_with_no_data: built.series.flatMap((item) =>
        item.note === "no_data_in_range" ? [item.metric] : [],
      ),
      range_clamped: earliestAvailable != null && input.start_date < earliestAvailable,
      earliest_available: earliestAvailable,
    },
  };
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
  server.registerTool(
    "get_daily_health_summary",
    {
      title: "Get Daily Health Summary",
      description: "Return server-computed health metrics for one day.",
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      inputSchema: {
        date: dateSchema,
        timezone: z.string().optional(),
      },
      outputSchema: mcpOutputSchemas.dailyHealthSummary,
    },
    async ({ date, timezone }) => {
      requireMcpScope(context.scopes, "health:read");
      const repository = new DailyMetricsRepository(
        context.db,
        context.userId,
        timezone ?? context.timezone,
      );
      const rows = await repository.list(1, date);
      return jsonToolResult(rows[0] ?? null);
    },
  );
  server.registerTool(
    "get_health_trends",
    {
      title: "Get Health Trends",
      description:
        "Show daily HRV and step trends, or other health metrics, for an exact date range with baseline-relative recovery context.",
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      inputSchema: {
        start_date: dateSchema,
        end_date: dateSchema,
        metrics: z.array(healthMetricSchema).optional(),
        granularity: z.enum(["daily", "weekly"]).optional(),
        timezone: z.string().optional(),
      },
      outputSchema: mcpOutputSchemas.healthTrends,
    },
    async ({ start_date, end_date, metrics, granularity, timezone }) => {
      requireMcpScope(context.scopes, "health:read");
      const requestedTimezone = timezone ?? context.timezone;
      const input = {
        start_date,
        end_date,
        metrics: metrics ?? healthMetricSchema.options,
        granularity: granularity ?? "daily",
        timezone,
      };
      return jsonToolResult(
        await healthTrendsResponse(
          context,
          await listHealthTrends(context, input),
          input,
          requestedTimezone,
        ),
      );
    },
  );
  server.registerTool(
    "get_data_coverage",
    {
      title: "Get Data Coverage",
      description:
        "Return first and last observed dates, observed-day counts, and source providers for every health metric.",
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      inputSchema: {},
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
  registerCyclingPerformanceTool(server, context);
  registerActivityStreamsTool(server, context);
  registerActivityDetailsTool(server, context);
  registerClimbingSessionsTool(server, context);
  registerStrengthSessionsTool(server, context);
  registerSupplementsTool(server, context);
  server.registerTool(
    "render_health_explorer",
    {
      title: "Render Health Explorer",
      description:
        "Open the interactive Dofek Analytics Explorer for server-computed health metrics in an exact date range.",
      inputSchema: healthExplorerInputSchema,
      outputSchema: healthExplorerSnapshotSchema,
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      _meta: { ui: { resourceUri: healthExplorerResourceUri } },
    },
    async (input) => {
      requireMcpScope(context.scopes, "health:read");
      const timezone = input.timezone ?? context.timezone;
      const snapshot = healthExplorerSnapshotSchema.parse(
        await new HealthExplorerService({
          list: (request) => listHealthTrends(context, request),
        }).snapshot({ ...input, timezone }),
      );
      return {
        structuredContent: snapshot,
        content: [
          {
            type: "text" as const,
            text: `Dofek Analytics Explorer coverage: ${Object.entries(snapshot.coverage.by_metric)
              .map(
                ([metric, coverage]) =>
                  `${metric} ${coverage.observed_days} of ${snapshot.coverage.requested_days} days`,
              )
              .join("; ")}.`,
          },
        ],
        _meta: { ui: { resourceUri: healthExplorerResourceUri } },
      };
    },
  );
  server.registerTool(
    "get_sleep_summary",
    {
      title: "Get Sleep Summary",
      description:
        "Summarize sleep by night, including duration, efficiency, stages, and timing, for an exact date range.",
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      inputSchema: {
        start_date: dateSchema,
        end_date: dateSchema,
        timezone: z.string().optional(),
      },
      outputSchema: mcpOutputSchemas.sleepSummary,
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
      return jsonToolResult(
        rows.map((row) => {
          const localTimeContext = {
            timezone: row.timezone,
            startUtcOffsetMinutes: row.start_utc_offset_minutes,
            endUtcOffsetMinutes: row.end_utc_offset_minutes,
            source: row.local_time_source,
          };
          const onsetTime = formatRecordLocalTime(
            row.started_at,
            localTimeContext,
            "start",
            undefined,
            requestedTimezone,
          );
          const wakeTime =
            row.ended_at == null
              ? "--"
              : formatRecordLocalTime(
                  row.ended_at,
                  localTimeContext,
                  "end",
                  undefined,
                  requestedTimezone,
                );
          return {
            date: row.date,
            staging_available: row.staging_available,
            total_duration_minutes: row.duration_minutes,
            sleep_efficiency_pct: row.efficiency_pct,
            time_in_bed_minutes:
              row.duration_minutes == null ? null : row.duration_minutes + (row.awake_minutes ?? 0),
            onset_time: onsetTime === "--" ? null : onsetTime,
            wake_time: wakeTime === "--" ? null : wakeTime,
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
      description:
        "Show authenticated user activities in an optional date range (defaulting to the last 30 days), optionally filtered by text.",
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      inputSchema: {
        from: dateSchema.optional(),
        to: dateSchema.optional(),
        query: z.string().max(200).optional(),
        include: z.array(z.literal("mapPreview")).optional(),
        limit: z.number().int().min(1).max(25).optional(),
      },
      outputSchema: mcpOutputSchemas.searchActivities,
    },
    async ({ from, to, query, include, limit }) => {
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
      const resultLimit = limit ?? 10;
      let result: Awaited<ReturnType<ActivityRepository["search"]>>;
      try {
        result = await repository.search({
          startDate,
          endDate,
          query,
          limit: resultLimit,
        });
      } catch (error: unknown) {
        captureException(error, {
          tags: { mcp_tool: "search_activities" },
          extra: { startDate, endDate, hasQuery: query !== undefined, limit: resultLimit },
        });
        throw error;
      }
      if (include?.includes("mapPreview")) return jsonToolResult(result);
      return jsonToolResult({
        ...result,
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
  server.registerTool(
    "get_activity_summary",
    {
      title: "Get Activity Summary",
      description: "Aggregate activity volume and effort over an exact date range.",
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      inputSchema: {
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
      },
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
  server.registerTool(
    "get_finger_loading",
    {
      title: "Get Finger Loading",
      description:
        "Return structured finger-loading protocols and server-computed effective load for an exact date range.",
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      inputSchema: {
        start_date: dateSchema,
        end_date: dateSchema,
        timezone: z.string().optional(),
      },
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
          total_time_under_tension_seconds: row.holdDurationSeconds * row.setCount,
        })),
      );
    },
  );
  server.registerTool(
    "get_nutrition_summary",
    {
      title: "Get Nutrition Summary",
      description: "Return daily calorie, macronutrient, fiber, and meal totals for a date range.",
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      inputSchema: {
        start_date: dateSchema,
        end_date: dateSchema,
        timezone: z.string().optional(),
      },
      outputSchema: mcpOutputSchemas.nutritionSummary,
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
      return jsonToolResult(
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
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      inputSchema: {
        start_date: dateSchema,
        end_date: dateSchema,
      },
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
          body_fat_pct: row.bodyFatPct,
          lean_mass_kg: row.leanMassKg,
          bmi: row.bmi,
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
  server.registerTool(
    "get_subjective_timeline",
    {
      title: "Get Subjective Timeline",
      description: "Return raw subjective check-ins, symptoms, and injury events for a date range.",
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      inputSchema: {
        start_date: dateSchema,
        end_date: dateSchema,
      },
      outputSchema: mcpOutputSchemas.subjectiveTimeline,
    },
    async ({ start_date, end_date }) => {
      requireMcpScope(context.scopes, "health:read");
      assertDateRange(start_date, end_date);
      const repository = new SubjectiveRepository(context.db, context.userId, context.timezone);
      return jsonToolResult(await repository.timeline(start_date, end_date));
    },
  );
  server.registerTool(
    "list_providers",
    {
      title: "List Providers",
      description:
        "List configured Dofek providers with connection status and last-sync timestamps.",
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      inputSchema: {},
      outputSchema: mcpOutputSchemas.providers,
    },
    async () => {
      requireMcpScope(context.scopes, "providers:read");
      return jsonToolResult(await listProviderStatuses(context));
    },
  );
  server.registerTool(
    "start_provider_sync",
    {
      title: "Start Provider Sync",
      description: "Enqueue a user-scoped provider sync job.",
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
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
            origin: "manual",
            ...syncWindowToJobData(syncWindow, sinceDays),
          },
          { skipWhenRateLimited: true },
        ),
      );
      if (!job) {
        throw new Error(`Provider ${providerId} sync skipped: rate-limit cooldown active`);
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
