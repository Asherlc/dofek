import {
  type HealthExplorerInput,
  type HealthMetric,
  healthExplorerInputSchema,
  healthExplorerSnapshotSchema,
  healthMetricSchema,
} from "@dofek/mcp-contracts/health-explorer";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { dateSchema } from "../lib/date-schema.ts";
import { DailyMetricsRepository } from "../repositories/daily-metrics-repository.ts";
import { DataCoverageRepository } from "../repositories/data-coverage-repository.ts";
import {
  type DailyRecoveryBaseline,
  latestRecoveryBaselineMetrics,
  RecoveryBaselineRepository,
} from "../repositories/recovery-baseline-repository.ts";
import { fetchRestingHeartRateValuesCte } from "../repositories/resting-heart-rate-query.ts";
import { healthExplorerResourceUri } from "./app-resource.ts";
import type { DofekMcpContext } from "./context.ts";
import { HealthExplorerService } from "./health-explorer-service.ts";
import { buildHealthSeries, type HealthTrendRow } from "./health-series-service.ts";
import { requireMcpScope } from "./token-repository.ts";
import { aggregateNumbers, isoWeek } from "./tool-aggregation.ts";
import { mcpOutputSchemas } from "./tool-output.ts";
import { jsonToolResult } from "./tool-result.ts";
import { assertDateRange } from "./tool-utils.ts";

export function registerHealthTrendTools(server: McpServer, context: DofekMcpContext): void {
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

  function daysBetween(startDate: string, endDate: string): number {
    const start = new Date(`${startDate}T00:00:00Z`);
    const end = new Date(`${endDate}T00:00:00Z`);
    return Math.round((end.getTime() - start.getTime()) / 86_400_000);
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
        timezone: requestedTimezone,
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
}
