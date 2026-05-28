import {
  type FormattedMeasurement,
  formatCaloriesMeasurement,
  formatHRVMeasurement,
  formatSpO2Measurement,
} from "@dofek/format/format";
import type { UnitConverter } from "@dofek/format/units";
import { useMemo } from "react";
import { z } from "zod";
import type { Insight } from "../components/CorrelationCard.tsx";
import { DailyOverview } from "../components/DailyOverview.tsx";
import { DashboardEvidenceOverview } from "../components/DashboardEvidenceOverview.tsx";
import { HealthStatusBar } from "../components/HealthStatusBar.tsx";
import { PageLayout } from "../components/PageLayout.tsx";
import { QueryStatePanel } from "../components/QueryStatePanel.tsx";
import { useAutoSync } from "../hooks/useAutoSync.ts";
import { useTodayQueryDate } from "../hooks/useTodayQueryDate.ts";
import { chartColors } from "../lib/chartTheme.ts";
import { trpc } from "../lib/trpc.ts";
import { useUnitConverter } from "../lib/unitContext.ts";
import { useProviderGuide } from "../lib/useProviderGuide.ts";

type MetricEntry = {
  label: string;
  value: number | null;
  avg: number | null;
  stddev: number | null;
  unit?: string;
  formatValue?: (value: number | null | undefined) => FormattedMeasurement;
  lowerBetter?: boolean;
};

const trendRowSchema = z.object({
  avg_hrv: z.number().nullable(),
  avg_resting_hr: z.number().nullable(),
  avg_spo2: z.number().nullable(),
  avg_steps: z.number().nullable(),
  avg_active_energy: z.number().nullable(),
  avg_skin_temp: z.number().nullable(),
  stddev_hrv: z.number().nullable(),
  stddev_resting_hr: z.number().nullable(),
  stddev_spo2: z.number().nullable(),
  stddev_skin_temp: z.number().nullable(),
  latest_hrv: z.number().nullable(),
  latest_resting_hr: z.number().nullable(),
  latest_spo2: z.number().nullable(),
  latest_steps: z.number().nullable(),
  latest_active_energy: z.number().nullable(),
  latest_skin_temp: z.number().nullable(),
  latest_date: z.string().nullable(),
});
type TrendRow = z.infer<typeof trendRowSchema>;

const dailyMetricRowSchema = z.object({
  date: z.string(),
  hrv: z.number().nullable(),
  spo2_avg: z.number().nullable(),
  skin_temp_c: z.number().nullable(),
  steps: z.number().nullable(),
  active_energy_kcal: z.number().nullable(),
});

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
      title: "SpO2 & Skin Temperature",
      subtitle: "Blood oxygen saturation and wrist skin temperature over time",
      yAxis: [{ name: "SpO2 (%)", min: 90 }, { name: units.temperatureLabel }],
    };
  }
  if (hasSpO2) {
    return {
      title: "Blood Oxygen (SpO2)",
      subtitle: "Blood oxygen saturation over time",
      yAxis: [{ name: "SpO2 (%)", min: 90 }],
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

export function buildHealthMetrics(trendData: TrendRow | undefined, units: UnitConverter) {
  if (!trendData) return [];
  const entries: (MetricEntry | false)[] = [
    {
      label: "Heart Rate Variability (HRV)",
      value: trendData.latest_hrv,
      avg: trendData.avg_hrv,
      stddev: trendData.stddev_hrv,
      formatValue: formatHRVMeasurement,
      lowerBetter: false,
    },
    {
      label: "Resting Heart Rate",
      value: trendData.latest_resting_hr,
      avg: trendData.avg_resting_hr,
      stddev: trendData.stddev_resting_hr,
      unit: "bpm",
      lowerBetter: true,
    },
    trendData.latest_spo2 != null && {
      label: "SpO2",
      value: trendData.latest_spo2,
      avg: trendData.avg_spo2,
      stddev: trendData.stddev_spo2,
      formatValue: formatSpO2Measurement,
    },
    {
      label: "Steps",
      value: trendData.latest_steps,
      avg: trendData.avg_steps,
      stddev: null,
    },
    {
      label: "Active Energy",
      value: trendData.latest_active_energy,
      avg: trendData.avg_active_energy,
      stddev: null,
      formatValue: formatCaloriesMeasurement,
    },
    trendData.latest_skin_temp != null && {
      label: "Skin Temp",
      value: trendData.latest_skin_temp,
      avg: trendData.avg_skin_temp,
      stddev: trendData.stddev_skin_temp,
      formatValue: (value) => units.formatTemperature(value),
    },
  ];
  return entries.filter((entry): entry is MetricEntry => entry !== false);
}

export function Dashboard() {
  const units = useUnitConverter();
  const days = 30;
  const endDate = useTodayQueryDate();
  const readinessData = trpc.recovery.readinessScore.useQuery({ days, endDate });
  const workloadRatio = trpc.recovery.workloadRatio.useQuery({ days, endDate });
  const strainTarget = trpc.recovery.strainTarget.useQuery({ days, endDate });
  const sleepPerformance = trpc.sleepNeed.performance.useQuery({ endDate });
  const providerGuide = useProviderGuide();
  const trends = trpc.dailyMetrics.trends.useQuery({ days, endDate });
  const insightsQuery = trpc.insights.compute.useQuery({ days, endDate });
  const trendData: TrendRow | undefined = trends.data
    ? trendRowSchema.parse(trends.data)
    : undefined;

  // Auto-sync when data is stale (API providers only — HealthKit requires iOS)
  useAutoSync(trendData?.latest_date);

  const topInsight = useMemo(() => {
    const allInsights: Insight[] = insightsQuery.data ?? [];
    return allInsights
      .filter((insight) => insight.confidence !== "insufficient")
      .sort((firstInsight, secondInsight) => {
        return Math.abs(secondInsight.effectSize) - Math.abs(firstInsight.effectSize);
      })[0];
  }, [insightsQuery.data]);

  const healthMetrics = useMemo(() => buildHealthMetrics(trendData, units), [trendData, units]);

  const healthMonitor = trends.error ? (
    <QueryStatePanel error={trends.error} height={160} />
  ) : (
    <HealthStatusBar metrics={healthMetrics} loading={trends.isLoading} />
  );

  return (
    <PageLayout headerChildren={undefined}>
      <DashboardEvidenceOverview
        days={days}
        endDate={endDate}
        topInsight={topInsight}
        trend={{
          latestRestingHeartRate: trendData?.latest_resting_hr,
          averageRestingHeartRate: trendData?.avg_resting_hr,
        }}
        sources={providerGuide.providers}
        dailySummary={
          <DailyOverview
            embedded
            endDate={endDate}
            readiness={readinessData.data}
            workloadRatio={workloadRatio.data}
            strainTarget={strainTarget.data}
            sleepPerformance={sleepPerformance.data}
            readinessLoading={readinessData.isLoading}
            workloadLoading={workloadRatio.isLoading}
            strainTargetLoading={strainTarget.isLoading}
            sleepLoading={sleepPerformance.isLoading}
          />
        }
        healthMonitor={healthMonitor}
      />
    </PageLayout>
  );
}
