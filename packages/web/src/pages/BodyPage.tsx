import { BODY_TREND_WEIGHT_DECISION_COPY } from "@dofek/format/body-decision-context";
import { formatSpO2 } from "@dofek/format/format";
import type { UnitConverter } from "@dofek/format/units";
import { healthStatusMetricSchema } from "dofek-server/mobile-dashboard-contracts";
import { useMemo } from "react";
import { z } from "zod";
import { BodyDecisionContext } from "../components/BodyDecisionContext.tsx";
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
import { ChartLoadingSkeleton } from "../components/LoadingSkeleton.tsx";
import { PageSection } from "../components/PageSection.tsx";
import { getQueryErrorMessage, QueryStatePanel } from "../components/QueryStatePanel.tsx";
import { SmoothedWeightChart } from "../components/SmoothedWeightChart.tsx";
import { StressChart } from "../components/StressChart.tsx";
import { TimeRangeSelector } from "../components/TimeRangeSelector.tsx";
import { TimeSeriesChart } from "../components/TimeSeriesChart.tsx";
import { WeightPredictionSummary } from "../components/WeightPredictionSummary.tsx";
import { useTodayQueryDate } from "../hooks/useTodayQueryDate.ts";
import { useBodyDays } from "../lib/bodyDaysContext.ts";
import { chartColors } from "../lib/chartTheme.ts";
import { minimumSelectedRangeQueryInput, selectedRangeQueryInput } from "../lib/timeRange.ts";
import { trpc } from "../lib/trpc.ts";
import { useUnitConverter } from "../lib/unitContext.ts";
import { assertRows } from "../lib/utils.ts";

const trendRowSchema = z.object({
  avg_resting_hr: z.number().nullable(),
  latest_resting_hr: z.number().nullable(),
  stddev_resting_hr: z.number().nullable(),
  healthStatus: z.array(healthStatusMetricSchema),
});

const dailyMetricRowSchema = z.object({
  date: z.string(),
  hrv: z.number().nullable(),
  spo2_avg: z.number().nullable(),
  skin_temp_c: z.number().nullable(),
  steps: z.number().nullable(),
});

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

type QueryResultWithData = { data?: unknown; isError: boolean };

function isQueryUnavailable(query: QueryResultWithData): boolean {
  return query.isError && query.data == null;
}

function BodySectionUnavailable({ label }: { label: string }) {
  return (
    <QueryStatePanel
      variant="empty"
      height={48}
      message={`${label} is unavailable. Retry from the notice above.`}
    />
  );
}

export function BodyPage() {
  const units = useUnitConverter();
  const { days, description, setDays } = useBodyDays();
  const endDate = useTodayQueryDate();

  const trends = trpc.dailyMetrics.trends.useQuery({ ...selectedRangeQueryInput(days), endDate });
  const dailyMetrics = trpc.dailyMetrics.list.useQuery({
    ...selectedRangeQueryInput(days),
    endDate,
  });
  const hrvBaseline = trpc.dailyMetrics.hrvBaseline.useQuery({
    ...selectedRangeQueryInput(days),
    endDate,
  });
  const stressData = trpc.stress.scores.useQuery({ ...selectedRangeQueryInput(days), endDate });
  const weightOverview = trpc.bodyAnalytics.weightOverview.useQuery({
    ...selectedRangeQueryInput(days),
    endDate,
  });
  const insightsQuery = trpc.insights.compute.useQuery({
    ...minimumSelectedRangeQueryInput(days, 90),
    endDate,
  });

  const trendData = trends.data ? trendRowSchema.parse(trends.data) : undefined;
  const metrics = assertRows(dailyMetrics.data, dailyMetricRowSchema);

  const hasSpO2 = metrics.some((d) => d.spo2_avg != null);
  const hasSkinTemp = metrics.some((d) => d.skin_temp_c != null);

  const spo2Series = useMemo(
    () => ({
      name: "Blood Oxygen Saturation (SpO2)",
      data: metrics.map((d): [string, number | null] => [d.date, d.spo2_avg]),
      color: chartColors.blue,
      areaStyle: true,
      formatValue: formatSpO2,
    }),
    [metrics],
  );

  const skinTempSeries = useMemo(() => buildSkinTempSeries(metrics, units), [metrics, units]);

  const smoothedWeightData = weightOverview.data?.smoothedWeight ?? [];

  const trendsUnavailable = isQueryUnavailable(trends);
  const dailyMetricsUnavailable = isQueryUnavailable(dailyMetrics);
  const hrvUnavailable = isQueryUnavailable(hrvBaseline);
  const stressUnavailable = isQueryUnavailable(stressData);
  const weightOverviewUnavailable = isQueryUnavailable(weightOverview);
  const insightsUnavailable = isQueryUnavailable(insightsQuery);

  const healthMetrics = useMemo(() => {
    const restingHeartRate = trendData?.healthStatus.find(
      (metric) => metric.metric === "resting_heart_rate",
    );
    return [
      ...(restingHeartRate ? [restingHeartRate] : []),
      ...(weightOverview.data?.healthStatus ?? []),
    ];
  }, [trendData, weightOverview.data]);

  const bodyInsights = useMemo(() => {
    const all: Insight[] = insightsQuery.data ?? [];
    return all
      .filter((i) => i.confidence !== "insufficient" && isBodyInsight(i.metric))
      .sort((a, b) => Math.abs(b.effectSize) - Math.abs(a.effectSize));
  }, [insightsQuery.data]);

  const weightPredictionDisplay = weightOverview.data?.prediction ?? null;

  const predictionSectionError =
    weightOverview.isSuccess && weightOverview.data.prediction == null
      ? new Error("Weight prediction is temporarily unavailable.")
      : null;

  const failedDependencies = [
    {
      id: "health-overview",
      label: "Health overview",
      query: trends,
      retry: () => trends.refetch(),
    },
    {
      id: "daily-metrics",
      label: "Blood oxygen and skin temperature",
      query: dailyMetrics,
      retry: () => dailyMetrics.refetch(),
    },
    {
      id: "hrv",
      label: "Heart rate variability",
      query: hrvBaseline,
      retry: () => hrvBaseline.refetch(),
    },
    {
      id: "stress",
      label: "Stress",
      query: stressData,
      retry: () => stressData.refetch(),
    },
    {
      id: "body-composition",
      label: "Body composition",
      query: weightOverview,
      retry: () => weightOverview.refetch(),
    },
    {
      id: "insights",
      label: "Body insights",
      query: insightsQuery,
      retry: () => insightsQuery.refetch(),
    },
  ].filter((dependency) => dependency.query.isError);
  const hasUnavailableDependency = failedDependencies.some(
    (dependency) => dependency.query.data == null,
  );
  const retryFailedDependencies = () => {
    for (const dependency of failedDependencies) {
      void dependency.retry();
    }
  };

  // SpO2/temp chart config
  const spo2TempTitle =
    hasSpO2 && hasSkinTemp
      ? "Blood Oxygen Saturation (SpO2) & Skin Temperature"
      : hasSpO2
        ? "Blood Oxygen Saturation (SpO2)"
        : "Skin Temperature";

  const spo2TempYAxis =
    hasSpO2 && hasSkinTemp
      ? [{ name: "Blood Oxygen Saturation (%)", min: 90 }, { name: units.temperatureLabel }]
      : hasSpO2
        ? [{ name: "Blood Oxygen Saturation (%)", min: 90 }]
        : [{ name: units.temperatureLabel }];

  return (
    <>
      <div className="flex justify-end">
        <TimeRangeSelector days={days} description={description} onChange={setDays} />
      </div>

      {failedDependencies.length > 0 ? (
        <QueryStatePanel
          contextLabel="Body data"
          error={failedDependencies[0]?.query.error}
          height={72}
          message={
            <span className="space-y-1">
              <span className="block">
                {hasUnavailableDependency
                  ? "Some sections are unavailable. Other body data remains visible."
                  : "Previously loaded body data remains visible, but some sections could not refresh."}
              </span>
              {failedDependencies.map((dependency) => (
                <span className="block" key={dependency.id}>
                  <strong>{dependency.label}:</strong>{" "}
                  {getQueryErrorMessage(dependency.query.error)}
                </span>
              ))}
            </span>
          }
          onRetry={retryFailedDependencies}
          retryLabel="Retry unavailable body data"
          retrying={failedDependencies.some((dependency) => dependency.query.isFetching)}
        />
      ) : null}

      {/* Health Status Bar */}
      {trendsUnavailable && weightOverviewUnavailable ? (
        <BodySectionUnavailable label="Health overview" />
      ) : (
        <HealthStatusBar
          metrics={healthMetrics}
          loading={trends.isLoading || weightOverview.isLoading}
          formatters={{ trend_weight: (value) => units.formatWeight(value) }}
          units={{ resting_heart_rate: "bpm", body_fat_percentage: "%" }}
        />
      )}

      {/* HRV & Resting HR */}
      <PageSection title="Heart Rate Variability & Resting Heart Rate">
        {hrvUnavailable ? (
          <BodySectionUnavailable label="Heart rate variability" />
        ) : (
          <HrvBaselineChart data={hrvBaseline.data ?? []} loading={hrvBaseline.isLoading} />
        )}
      </PageSection>

      {/* Stress */}
      <PageSection title="Stress Monitor">
        {stressUnavailable ? (
          <BodySectionUnavailable label="Stress data" />
        ) : (
          <StressChart data={stressData.data} loading={stressData.isLoading} />
        )}
      </PageSection>

      {/* SpO2 & Skin Temp */}
      {(hasSpO2 || hasSkinTemp || dailyMetricsUnavailable) && (
        <PageSection title={spo2TempTitle}>
          {dailyMetricsUnavailable ? (
            <BodySectionUnavailable label="Blood oxygen and skin temperature" />
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
          ) : weightOverviewUnavailable ? (
            <BodySectionUnavailable label="Body composition" />
          ) : predictionSectionError ? (
            <QueryStatePanel error={predictionSectionError} height={48} />
          ) : weightPredictionDisplay ? (
            <WeightPredictionSummary
              prediction={weightPredictionDisplay}
              hasWeightTrendData={smoothedWeightData.length > 0}
            />
          ) : null}
        </div>
        {!weightOverviewUnavailable && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="card p-2 sm:p-4">
              <div className="mb-2 flex items-center gap-2">
                <h4 className="text-xs font-medium text-subtle uppercase">Trend Weight</h4>
                <ChartDescriptionTooltip description={BODY_TREND_WEIGHT_DECISION_COPY} />
              </div>
              {weightOverview.isPending ? (
                <SmoothedWeightChart data={[]} loading />
              ) : (
                <SmoothedWeightChart
                  data={smoothedWeightData}
                  prediction={weightPredictionDisplay}
                />
              )}
              <BodyDecisionContext context={weightOverview.data?.decisionContext ?? null} />
            </div>
            <div className="card p-2 sm:p-4">
              <div className="mb-2 flex items-center gap-2">
                <h4 className="text-xs font-medium text-subtle uppercase">Recomposition</h4>
                <ChartDescriptionTooltip description="This chart shows how fat mass and lean mass have changed so you can track body recomposition, not just scale weight." />
              </div>
              <BodyRecompositionChart
                data={weightOverview.data?.recomposition ?? []}
                loading={weightOverview.isLoading}
              />
            </div>
          </div>
        )}
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

      {insightsUnavailable && (
        <PageSection title="Body Insights" card={false}>
          <BodySectionUnavailable label="Body insights" />
        </PageSection>
      )}

      {!insightsQuery.isLoading && !insightsUnavailable && bodyInsights.length > 0 && (
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
