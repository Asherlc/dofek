import {
  type FormattedMeasurement,
  formatHRVMeasurement,
  formatSpO2,
  formatSpO2Measurement,
} from "@dofek/format/format";
import type { UnitConverter } from "@dofek/format/units";
import { useMemo } from "react";
import { z } from "zod";
import { BodyRecompositionChart } from "../components/BodyRecompositionChart.tsx";
import { ChartDescriptionTooltip } from "../components/ChartDescriptionTooltip.tsx";
import {
  CorrelationCard,
  CorrelationCardSkeleton,
  type Insight,
} from "../components/CorrelationCard.tsx";
import { GoalWeightInput } from "../components/GoalWeightInput.tsx";
import { HealthStatusBar } from "../components/HealthStatusBar.tsx";
import { HrvBaselineChart } from "../components/HrvBaselineChart.tsx";
import { PageSection } from "../components/PageSection.tsx";
import { QueryStatePanel } from "../components/QueryStatePanel.tsx";
import { SmoothedWeightChart } from "../components/SmoothedWeightChart.tsx";
import { StressChart } from "../components/StressChart.tsx";
import { TimeRangeSelector } from "../components/TimeRangeSelector.tsx";
import { TimeSeriesChart } from "../components/TimeSeriesChart.tsx";
import { ChartLoadingSkeleton } from "../components/LoadingSkeleton.tsx";
import { WeightPredictionSummary } from "../components/WeightPredictionSummary.tsx";
import { useBodyDays } from "../lib/bodyDaysContext.ts";
import { chartColors } from "../lib/chartTheme.ts";
import { enrichWeightPrediction } from "../lib/enrichWeightPrediction.ts";
import { useTodayQueryDate } from "../hooks/useTodayQueryDate.ts";
import { trpc } from "../lib/trpc.ts";
import { useUnitConverter } from "../lib/unitContext.ts";
import { assertRows } from "../lib/utils.ts";

const trendRowSchema = z.object({
  avg_hrv: z.number().nullable(),
  avg_spo2: z.number().nullable(),
  avg_steps: z.number().nullable(),
  avg_active_energy: z.number().nullable(),
  avg_skin_temp: z.number().nullable(),
  stddev_hrv: z.number().nullable(),
  stddev_spo2: z.number().nullable(),
  stddev_skin_temp: z.number().nullable(),
  latest_hrv: z.number().nullable(),
  latest_spo2: z.number().nullable(),
  latest_steps: z.number().nullable(),
  latest_active_energy: z.number().nullable(),
  latest_skin_temp: z.number().nullable(),
  latest_date: z.string().nullable(),
});

const dailyMetricRowSchema = z.object({
  date: z.string(),
  hrv: z.number().nullable(),
  spo2_avg: z.number().nullable(),
  skin_temp_c: z.number().nullable(),
  steps: z.number().nullable(),
  active_energy_kcal: z.number().nullable(),
});

type MetricEntry = {
  label: string;
  value: number | null;
  avg: number | null;
  stddev: number | null;
  unit?: string;
  formatValue?: (value: number | null | undefined) => FormattedMeasurement;
  lowerBetter?: boolean;
};

function isBodyInsight(metric: string): boolean {
  return /hrv|resting.?hr|heart.?rate|weight|body.?fat|bmi|spo2|skin.?temp/i.test(metric);
}

function buildSkinTempSeries(
  metrics: Array<{ date: string; skin_temp_c: number | null }>,
  units: UnitConverter,
) {
  return {
    name: "Skin Temp",
    data: metrics.map((d): [string, number | null] => [
      d.date,
      d.skin_temp_c != null ? units.convertTemperature(d.skin_temp_c) : null,
    ]),
    color: chartColors.amber,
    yAxisIndex: 1 as const,
  };
}

function getQueryError(...queries: Array<{ isError: boolean; error: unknown }>): unknown {
  for (const query of queries) {
    if (query.isError) return query.error;
  }
  return null;
}

export function BodyPage() {
  const units = useUnitConverter();
  const { days, setDays } = useBodyDays();
  const endDate = useTodayQueryDate();

  const trends = trpc.dailyMetrics.trends.useQuery({ days, endDate });
  const dailyMetrics = trpc.dailyMetrics.list.useQuery({ days, endDate });
  const hrvBaseline = trpc.dailyMetrics.hrvBaseline.useQuery({ days, endDate });
  const stressData = trpc.stress.scores.useQuery({ days, endDate });
  const weightOverview = trpc.bodyAnalytics.weightOverview.useQuery({
    days: Math.max(days, 90),
    endDate,
  });
  const bodyRecomp = trpc.bodyAnalytics.recomposition.useQuery({
    days: Math.max(days, 180),
    endDate,
  });
  const insightsQuery = trpc.insights.compute.useQuery({ days: Math.max(days, 90), endDate });

  const trendData = trends.data ? trendRowSchema.parse(trends.data) : undefined;
  const metrics = assertRows(dailyMetrics.data, dailyMetricRowSchema);

  const hasSpO2 = metrics.some((d) => d.spo2_avg != null);
  const hasSkinTemp = metrics.some((d) => d.skin_temp_c != null);

  const spo2Series = useMemo(
    () => ({
      name: "SpO2",
      data: metrics.map((d): [string, number | null] => [d.date, d.spo2_avg]),
      color: chartColors.blue,
      areaStyle: true,
      formatValue: formatSpO2,
    }),
    [metrics],
  );

  const skinTempSeries = useMemo(() => buildSkinTempSeries(metrics, units), [metrics, units]);

  const healthMetrics = useMemo(() => {
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
      trendData.latest_spo2 != null && {
        label: "SpO2",
        value: trendData.latest_spo2,
        avg: trendData.avg_spo2,
        stddev: trendData.stddev_spo2,
        formatValue: formatSpO2Measurement,
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
  }, [trendData, units]);

  const bodyInsights = useMemo(() => {
    const all: Insight[] = insightsQuery.data ?? [];
    return all
      .filter((i) => i.confidence !== "insufficient" && isBodyInsight(i.metric))
      .sort((a, b) => Math.abs(b.effectSize) - Math.abs(a.effectSize));
  }, [insightsQuery.data]);

  const weightPredictionDisplay = useMemo(() => {
    if (!weightOverview.data) return null;
    return enrichWeightPrediction(weightOverview.data.prediction, weightOverview.data.smoothedWeight);
  }, [weightOverview.data]);

  const smoothedWeightData = weightOverview.data?.smoothedWeight ?? [];
  const healthSectionError = getQueryError(trends, dailyMetrics);
  const hrvSectionError = getQueryError(hrvBaseline);
  const stressSectionError = getQueryError(stressData);
  const spo2SectionError = getQueryError(dailyMetrics);
  const bodyRecompSectionError = getQueryError(bodyRecomp);
  const insightsSectionError = getQueryError(insightsQuery);

  // SpO2/temp chart config
  const spo2TempTitle =
    hasSpO2 && hasSkinTemp
      ? "Blood Oxygen & Skin Temperature"
      : hasSpO2
        ? "Blood Oxygen (SpO2)"
        : "Skin Temperature";

  const spo2TempYAxis =
    hasSpO2 && hasSkinTemp
      ? [{ name: "SpO2 (%)", min: 90 }, { name: units.temperatureLabel }]
      : hasSpO2
        ? [{ name: "SpO2 (%)", min: 90 }]
        : [{ name: units.temperatureLabel }];

  return (
    <>
      <div className="flex justify-end">
        <TimeRangeSelector days={days} onChange={setDays} />
      </div>

      {/* Health Status Bar */}
      {healthSectionError ? (
        <QueryStatePanel error={healthSectionError} height={64} />
      ) : (
        <HealthStatusBar metrics={healthMetrics} loading={trends.isLoading || dailyMetrics.isLoading} />
      )}

      {/* HRV & Resting HR */}
      <PageSection title="Heart Rate Variability & Resting Heart Rate">
        {hrvSectionError ? (
          <QueryStatePanel error={hrvSectionError} height={200} />
        ) : (
          <HrvBaselineChart data={hrvBaseline.data ?? []} loading={hrvBaseline.isLoading} />
        )}
      </PageSection>

      {/* Stress */}
      <PageSection title="Stress Monitor">
        {stressSectionError ? (
          <QueryStatePanel error={stressSectionError} height={200} />
        ) : (
          <StressChart data={stressData.data} loading={stressData.isLoading} />
        )}
      </PageSection>

      {/* SpO2 & Skin Temp */}
      {(hasSpO2 || hasSkinTemp) && (
        <PageSection title={spo2TempTitle}>
          {spo2SectionError ? (
            <QueryStatePanel error={spo2SectionError} height={200} />
          ) : (
            <TimeSeriesChart
              series={[
                ...(hasSpO2 ? [spo2Series] : []),
                ...(hasSkinTemp
                  ? [hasSpO2 ? skinTempSeries : { ...skinTempSeries, yAxisIndex: 0 as const }]
                  : []),
              ]}
              height={200}
              yAxis={spo2TempYAxis}
              loading={dailyMetrics.isLoading}
            />
          )}
        </PageSection>
      )}

      {/* Body Composition */}
      <PageSection title="Body Composition" card={false}>
        <div className="card p-2 sm:p-4 mb-4">
          <div className="mb-2 flex items-center justify-between">
            <h4 className="text-xs font-medium text-subtle uppercase">Weight Prediction</h4>
            <GoalWeightInput />
          </div>
          {weightOverview.isPending ? (
            <ChartLoadingSkeleton height={48} />
          ) : weightOverview.isError ? (
            <QueryStatePanel error={weightOverview.error} height={48} />
          ) : weightPredictionDisplay ? (
            <WeightPredictionSummary
              prediction={weightPredictionDisplay}
              hasWeightTrendData={smoothedWeightData.length > 0}
            />
          ) : null}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="card p-2 sm:p-4">
            <div className="mb-2 flex items-center gap-2">
              <h4 className="text-xs font-medium text-subtle uppercase">Weight Trend</h4>
              <ChartDescriptionTooltip description="This chart shows your smoothed body weight trend over time, with goal weight and forward projection when set." />
            </div>
            {weightOverview.isPending ? (
              <SmoothedWeightChart data={[]} loading />
            ) : weightOverview.isError ? (
              <QueryStatePanel error={weightOverview.error} height={250} />
            ) : (
              <SmoothedWeightChart
                data={smoothedWeightData}
                prediction={weightPredictionDisplay}
              />
            )}
          </div>
          <div className="card p-2 sm:p-4">
            <div className="mb-2 flex items-center gap-2">
              <h4 className="text-xs font-medium text-subtle uppercase">Recomposition</h4>
              <ChartDescriptionTooltip description="This chart shows how fat mass and lean mass have changed so you can track body recomposition, not just scale weight." />
            </div>
            {bodyRecompSectionError ? (
              <QueryStatePanel error={bodyRecompSectionError} height={250} />
            ) : (
              <BodyRecompositionChart data={bodyRecomp.data ?? []} loading={bodyRecomp.isLoading} />
            )}
          </div>
        </div>
      </PageSection>

      {/* Body Insights */}
      {insightsQuery.isLoading && (
        <PageSection title="Body Insights" card={false}>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {["b1", "b2"].map((id) => (
              <CorrelationCardSkeleton key={id} />
            ))}
          </div>
        </PageSection>
      )}

      {insightsSectionError && (
        <PageSection title="Body Insights" card={false}>
          <QueryStatePanel error={insightsSectionError} height={120} />
        </PageSection>
      )}

      {!insightsQuery.isLoading && !insightsSectionError && bodyInsights.length > 0 && (
        <PageSection title="Body Insights" card={false}>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {bodyInsights.map((insight) => (
              <CorrelationCard key={insight.id} insight={insight} />
            ))}
          </div>
        </PageSection>
      )}
    </>
  );
}
