import { formatSpO2Measurement } from "@dofek/format/format";
import type { UnitConverter } from "@dofek/format/units";
import { baselineRelativeMetricSchema } from "dofek-server/baseline-relative-metrics";
import {
  type HealthStatusMetric,
  healthStatusMetricSchema,
} from "dofek-server/mobile-dashboard-contracts";
import { useMemo } from "react";
import { z } from "zod";
import type { Insight } from "../components/CorrelationCard.tsx";
import { DailyOverview } from "../components/DailyOverview.tsx";
import { DashboardEvidenceOverview } from "../components/DashboardEvidenceOverview.tsx";
import { HealthStatusBar } from "../components/HealthStatusBar.tsx";
import { PageLayout } from "../components/PageLayout.tsx";
import { ProcessingStatusWidget } from "../components/ProcessingStatusWidget.tsx";
import { QueryStatePanel } from "../components/QueryStatePanel.tsx";
import { TodayPlanCard } from "../components/TodayPlanCard.tsx";
import { useAutoSync } from "../hooks/useAutoSync.ts";
import { useProcessingStatus } from "../hooks/useProcessingStatus.ts";
import { useTodayQueryDate } from "../hooks/useTodayQueryDate.ts";
import { chartColors } from "../lib/chartTheme.ts";
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

const dailyMetricRowSchema = z.object({
  date: z.string(),
  hrv: z.number().nullable(),
  spo2_avg: z.number().nullable(),
  skin_temp_c: z.number().nullable(),
  steps: z.number().nullable(),
});

const restingHeartRateChartRowSchema = z
  .object({
    date: z.string(),
    resting_hr: z.number().nullable(),
  })
  .transform((row) => ({
    date: row.date,
    restingHeartRate: row.resting_hr,
  }));

export function healthMonitorSubtitle(): string {
  return "Latest values vs. rolling average";
}

type DailyMetricRow = z.infer<typeof dailyMetricRowSchema>;

export function spo2TempSectionConfig(
  hasSpO2: boolean,
  hasSkinTemp: boolean,
  units: UnitConverter,
): { title: string; subtitle: string; yAxis: { name: string; min?: number }[] } {
  if (hasSpO2 && hasSkinTemp) {
    return {
      title: "Blood Oxygen Saturation (SpO2) & Skin Temperature",
      subtitle: "Blood oxygen saturation and wrist skin temperature over time",
      yAxis: [{ name: "Blood Oxygen Saturation (%)", min: 90 }, { name: units.temperatureLabel }],
    };
  }
  if (hasSpO2) {
    return {
      title: "Blood Oxygen Saturation (SpO2)",
      subtitle: "Blood oxygen saturation over time",
      yAxis: [{ name: "Blood Oxygen Saturation (%)", min: 90 }],
    };
  }
  return {
    title: "Skin Temperature",
    subtitle: "Wrist skin temperature over time",
    yAxis: [{ name: units.temperatureLabel }],
  };
}

export function buildSkinTempSeries(metrics: DailyMetricRow[], units: UnitConverter) {
  return {
    name: "Skin Temp",
    data: metrics.map((dailyMetric): [string, number | null] => [
      dailyMetric.date,
      dailyMetric.skin_temp_c != null ? units.convertTemperature(dailyMetric.skin_temp_c) : null,
    ]),
    color: chartColors.amber,
    yAxisIndex: 1 as const,
  };
}

export function buildHealthMetrics(trendData: TrendRow | undefined): HealthStatusMetric[] {
  return trendData?.healthStatus ?? [];
}

export function isCoreDashboardReady({
  readinessReady,
  workloadRatioReady,
  strainTargetReady,
  sleepPerformanceReady,
}: {
  readinessReady: boolean;
  workloadRatioReady: boolean;
  strainTargetReady: boolean;
  sleepPerformanceReady: boolean;
}): boolean {
  return readinessReady && workloadRatioReady && strainTargetReady && sleepPerformanceReady;
}

export function Dashboard() {
  const units = useUnitConverter();
  const overviewDays = 90;
  const planLookbackDays = 30;
  const endDate = useTodayQueryDate();
  const readinessData = trpc.recovery.readinessScore.useQuery({ days: overviewDays, endDate });
  const workloadRatio = trpc.recovery.workloadRatio.useQuery({ days: overviewDays, endDate });
  const strainTarget = trpc.recovery.strainTarget.useQuery({ days: planLookbackDays, endDate });
  const sleepPerformance = trpc.sleepNeed.performance.useQuery({ endDate });
  const todayPlan = trpc.todayPlan.get.useQuery({ days: planLookbackDays, endDate });
  const trends = trpc.dailyMetrics.trends.useQuery({ days: overviewDays, endDate });
  const heartRateBaseline = trpc.dailyMetrics.hrvBaseline.useQuery({
    days: overviewDays,
    endDate,
  });
  const coreDashboardReady = isCoreDashboardReady({
    readinessReady:
      readinessData.data !== undefined || (readinessData.isFetched && readinessData.error == null),
    workloadRatioReady:
      workloadRatio.data !== undefined || (workloadRatio.isFetched && workloadRatio.error == null),
    strainTargetReady:
      strainTarget.data !== undefined || (strainTarget.isFetched && strainTarget.error == null),
    sleepPerformanceReady:
      sleepPerformance.data !== undefined ||
      (sleepPerformance.isFetched && sleepPerformance.error == null),
  });
  const coreDashboardLoading =
    readinessData.isLoading ||
    workloadRatio.isLoading ||
    strainTarget.isLoading ||
    sleepPerformance.isLoading;
  const insightsQuery = trpc.insights.compute.useQuery(
    { days: overviewDays, endDate },
    { enabled: coreDashboardReady },
  );
  const processingStatus = useProcessingStatus({
    datasets: ["activity", "sleep", "recovery", "training", "body"],
  });
  const trendData: TrendRow | undefined = trends.data
    ? trendRowSchema.parse(trends.data)
    : undefined;
  const restingHeartRateRows = heartRateBaseline.data
    ? z.array(restingHeartRateChartRowSchema).parse(heartRateBaseline.data)
    : [];

  // Auto-sync when data is stale (API providers only — HealthKit requires iOS)
  useAutoSync(trendData?.latest_date);

  const topInsight = useMemo(() => {
    const allInsights: Insight[] = [...(insightsQuery.data ?? [])];
    return allInsights
      .filter((insight) => insight.confidence !== "insufficient")
      .sort((firstInsight, secondInsight) => {
        return Math.abs(secondInsight.effectSize) - Math.abs(firstInsight.effectSize);
      })[0];
  }, [insightsQuery.data]);

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

  const healthMonitor =
    trends.error && trends.data == null ? (
      <QueryStatePanel error={trends.error} height={160} />
    ) : (
      <>
        <HealthStatusBar
          baselineRelative={trendData?.baselineRelative}
          metrics={healthMetrics}
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
        {trends.error ? <QueryStatePanel error={trends.error} height={72} /> : null}
      </>
    );
  const insightStatePanel =
    !coreDashboardReady && coreDashboardLoading ? (
      <QueryStatePanel variant="loading" height={160} />
    ) : !coreDashboardReady ? (
      <QueryStatePanel
        variant="empty"
        message="Insights unavailable until dashboard data loads."
        height={160}
      />
    ) : insightsQuery.isLoading ? (
      <QueryStatePanel variant="loading" height={160} />
    ) : insightsQuery.error ? (
      <QueryStatePanel error={insightsQuery.error} height={160} />
    ) : !insightsQuery.isFetched ? (
      <QueryStatePanel variant="loading" height={160} />
    ) : !topInsight ? (
      <QueryStatePanel variant="empty" message="No insights yet." height={160} />
    ) : null;

  return (
    <PageLayout headerChildren={undefined}>
      <ProcessingStatusWidget
        data={processingStatus.data}
        error={processingStatus.error}
        loading={processingStatus.isLoading}
      />
      <TodayPlanCard plan={todayPlan.data} loading={todayPlan.isLoading} error={todayPlan.error} />
      <DailyOverview
        endDate={endDate}
        summaryDateContext={sleepPerformance.data?.summaryDateContext}
        readiness={readinessData.data}
        workloadRatio={workloadRatio.data}
        strainTarget={strainTarget.data}
        sleepPerformance={sleepPerformance.data}
        readinessLoading={readinessData.isLoading}
        workloadLoading={workloadRatio.isLoading}
        strainTargetLoading={strainTarget.isLoading}
        sleepLoading={sleepPerformance.isLoading}
        readinessError={readinessData.error}
        workloadError={workloadRatio.error}
        strainTargetError={strainTarget.error}
        sleepError={sleepPerformance.error}
      />
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
        restingHeartRateError={heartRateBaseline.error}
        healthMonitor={healthMonitor}
      />
    </PageLayout>
  );
}
