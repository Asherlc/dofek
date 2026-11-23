import { formatSpO2Measurement } from "@dofek/format/format";
import { isConnectionFailure } from "@dofek/format/user-facing-error";
import { Link } from "@tanstack/react-router";
import { baselineRelativeMetricSchema } from "dofek-server/baseline-relative-metrics";
import {
  type HealthStatusMetric,
  healthStatusMetricSchema,
} from "dofek-server/mobile-dashboard-contracts";
import { useMemo } from "react";
import { z } from "zod";
import type { Insight } from "../components/CorrelationCard.tsx";
import { DashboardEvidenceOverview } from "../components/DashboardEvidenceOverview.tsx";
import { HealthStatusBar } from "../components/HealthStatusBar.tsx";
import { PageLayout } from "../components/PageLayout.tsx";
import { ProcessingStatusWidget } from "../components/ProcessingStatusWidget.tsx";
import { QueryStatePanel } from "../components/QueryStatePanel.tsx";
import { StrengthProgressionEvidence } from "../components/StrengthProgressionEvidence.tsx";
import { TrainingProgressionStatusCard } from "../components/TrainingProgressionStatusCard.tsx";
import { useProcessingStatus } from "../hooks/useProcessingStatus.ts";
import { useTodayQueryDate } from "../hooks/useTodayQueryDate.ts";
import { usePageLoadDomSection } from "../lib/page-load-context.tsx";
import {
  firstStatusRow,
  strengthEvidenceSummary,
  strengthHeadline,
} from "../lib/training-progression.ts";
import { trpc } from "../lib/trpc.ts";
import { useUnitConverter } from "../lib/unitContext.ts";

const trendRowSchema = z.object({
  avg_hrv: z.number().nullable(),
  avg_resting_hr: z.number().nullable(),
  avg_spo2: z.number().nullable(),
  avg_steps: z.number().nullable(),
  avg_skin_temp: z.number().nullable(),
  stddev_hrv: z.number().nullable(),
  stddev_resting_hr: z.number().nullable(),
  stddev_spo2: z.number().nullable(),
  stddev_steps: z.number().nullable(),
  stddev_skin_temp: z.number().nullable(),
  latest_hrv: z.number().nullable(),
  latest_resting_hr: z.number().nullable(),
  latest_spo2: z.number().nullable(),
  latest_steps: z.number().nullable(),
  latest_skin_temp: z.number().nullable(),
  latest_date: z.string().nullable(),
  restingHeartRateTrendLabel: z.string(),
  baselineRelative: z.array(baselineRelativeMetricSchema),
  healthStatus: z.array(healthStatusMetricSchema),
});
type TrendRow = z.infer<typeof trendRowSchema>;

const restingHeartRateChartRowSchema = z
  .object({
    date: z.string(),
    resting_hr: z.number().nullable(),
    resting_hr_mean_7d: z.number().nullable(),
  })
  .transform((row) => ({
    date: row.date,
    restingHeartRate: row.resting_hr == null ? null : row.resting_hr_mean_7d,
  }));

function buildHealthMetrics(trendData: TrendRow | undefined): HealthStatusMetric[] {
  return trendData?.healthStatus ?? [];
}

export function Dashboard() {
  const units = useUnitConverter();
  const overviewDays = 90;
  const endDate = useTodayQueryDate();
  const trends = trpc.dailyMetrics.trends.useQuery({ days: overviewDays, endDate });
  const heartRateBaseline = trpc.dailyMetrics.hrvBaseline.useQuery({
    days: overviewDays,
    endDate,
  });
  const insightsQuery = trpc.insights.compute.useQuery(
    { days: overviewDays, endDate },
    { refetchOnWindowFocus: true },
  );
  const strengthProgression = trpc.trainingProgression.strength.useQuery();
  const processingStatus = useProcessingStatus({
    datasets: ["activity", "sleep", "recovery", "training", "body"],
  });
  const connectionFailures = [
    trends.error,
    insightsQuery.error,
    heartRateBaseline.error,
    processingStatus.error,
    strengthProgression.error,
  ].filter((error) => error != null && isConnectionFailure(error));
  const sharedConnectionFailure = connectionFailures.length > 1;
  const strengthProgressionErrorHidden =
    sharedConnectionFailure && isConnectionFailure(strengthProgression.error);
  const trendData: TrendRow | undefined = trends.data
    ? trendRowSchema.parse(trends.data)
    : undefined;
  const restingHeartRateRows = heartRateBaseline.data
    ? z.array(restingHeartRateChartRowSchema).parse(heartRateBaseline.data)
    : [];

  const topInsight = useMemo(() => {
    const allInsights: Insight[] = [...(insightsQuery.data ?? [])];
    return allInsights
      .filter((insight) => insight.confidence !== "insufficient")
      .sort((firstInsight, secondInsight) => {
        return Math.abs(secondInsight.effectSize) - Math.abs(firstInsight.effectSize);
      })[0];
  }, [insightsQuery.data]);

  const latestStrengthStatus = firstStatusRow(strengthProgression.data);
  const healthMetrics = useMemo(() => buildHealthMetrics(trendData), [trendData]);
  const restingHeartRateStatus = healthMetrics.find(
    (metric) => metric.metric === "resting_heart_rate",
  );
  const restingHeartRatePoints = useMemo(
    () =>
      restingHeartRateRows.flatMap((row) =>
        row.restingHeartRate == null ? [] : [{ date: row.date, value: row.restingHeartRate }],
      ),
    [restingHeartRateRows],
  );

  usePageLoadDomSection(
    "health",
    trends.error
      ? "error"
      : trends.isFetching || !trends.isFetched
        ? undefined
        : trendData
          ? "ready"
          : "empty",
  );
  usePageLoadDomSection(
    "processing",
    processingStatus.error
      ? "error"
      : processingStatus.isFetching || !processingStatus.isFetched
        ? undefined
        : "ready",
  );
  usePageLoadDomSection(
    "insights",
    insightsQuery.error
      ? "error"
      : insightsQuery.isFetching || !insightsQuery.isFetched
        ? undefined
        : topInsight
          ? undefined
          : "empty",
  );
  usePageLoadDomSection("resting-heart-rate", heartRateBaseline.error ? "error" : undefined);

  const trendsErrorHidden = sharedConnectionFailure && isConnectionFailure(trends.error);
  const hideInsightCard =
    sharedConnectionFailure && isConnectionFailure(insightsQuery.error) && topInsight == null;
  // A distinct heart rate failure still owns the trend card even when the
  // grouped trend query has no data — keep the card so its error stays visible.
  const hasDistinctHeartRateError =
    heartRateBaseline.error != null && !isConnectionFailure(heartRateBaseline.error);
  const hideTrendCard =
    trendsErrorHidden &&
    trendData == null &&
    restingHeartRatePoints.length === 0 &&
    !hasDistinctHeartRateError;
  const hideHealthMonitor = trendsErrorHidden && trendData == null;
  const healthMonitor =
    trends.error && trends.data == null && !trendsErrorHidden ? (
      <QueryStatePanel error={trends.error} height={160} />
    ) : (
      <>
        <HealthStatusBar
          baselineRelative={trendData?.baselineRelative}
          metrics={healthMetrics}
          grouped
          loading={trends.isLoading}
          formatters={{
            spo2: formatSpO2Measurement,
            skin_temperature: (value) => units.formatTemperature(value),
          }}
          comparisonFormatters={{
            skin_temperature: (value) => units.formatTemperatureDelta(value),
          }}
          units={{
            hrv: "ms",
            respiratory_rate: "breaths/min",
            resting_heart_rate: "bpm",
            sleep_efficiency: "%",
          }}
        />
        {trends.error && !trendsErrorHidden ? (
          <QueryStatePanel error={trends.error} height={72} />
        ) : null}
      </>
    );
  const insightStatePanel = insightsQuery.isLoading ? (
    <QueryStatePanel variant="loading" height={160} />
  ) : insightsQuery.error ? (
    sharedConnectionFailure && isConnectionFailure(insightsQuery.error) ? null : (
      <QueryStatePanel error={insightsQuery.error} height={topInsight ? 72 : 160} />
    )
  ) : !insightsQuery.isFetched ? (
    <QueryStatePanel variant="loading" height={160} />
  ) : !topInsight ? (
    <QueryStatePanel variant="empty" message="No insights to display." height={160} />
  ) : null;

  return (
    <PageLayout headerChildren={undefined}>
      {sharedConnectionFailure ? (
        <QueryStatePanel error={connectionFailures[0]} height={72} />
      ) : null}
      <ProcessingStatusWidget
        data={processingStatus.data}
        error={
          sharedConnectionFailure && isConnectionFailure(processingStatus.error)
            ? undefined
            : processingStatus.error
        }
        loading={processingStatus.isLoading}
      />
      {strengthProgression.error && !strengthProgressionErrorHidden ? (
        <QueryStatePanel
          error={strengthProgression.error}
          height={latestStrengthStatus ? 72 : 160}
        />
      ) : null}
      {latestStrengthStatus ? (
        <TrainingProgressionStatusCard
          status={latestStrengthStatus.status}
          headline={strengthHeadline(latestStrengthStatus)}
          summary={strengthEvidenceSummary(latestStrengthStatus)}
          details={<StrengthProgressionEvidence row={latestStrengthStatus} />}
          action={
            <Link to="/training/strength" className="text-accent">
              Open Strength
            </Link>
          }
        />
      ) : null}
      <DashboardEvidenceOverview
        days={overviewDays}
        endDate={endDate}
        topInsight={topInsight}
        insightError={insightStatePanel}
        trend={{
          latestRestingHeartRate: trendData?.latest_resting_hr,
          averageRestingHeartRate: trendData?.avg_resting_hr,
          restingHeartRateTrendLabel: trendData?.restingHeartRateTrendLabel,
          restingHeartRateBaselineProgress: restingHeartRateStatus?.baselineProgress,
          restingHeartRatePoints,
        }}
        restingHeartRateLoading={heartRateBaseline.isLoading}
        restingHeartRateError={
          sharedConnectionFailure && isConnectionFailure(heartRateBaseline.error)
            ? undefined
            : heartRateBaseline.error
        }
        healthMonitor={healthMonitor}
        hideInsightCard={hideInsightCard}
        hideTrendCard={hideTrendCard}
        hideHealthMonitor={hideHealthMonitor}
      />
    </PageLayout>
  );
}
