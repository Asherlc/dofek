import { formatDateYmd } from "@dofek/format/format";
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
import { SmoothedWeightChart } from "../components/SmoothedWeightChart.tsx";
import { StressChart } from "../components/StressChart.tsx";
import { TimeRangeSelector } from "../components/TimeRangeSelector.tsx";
import { TimeSeriesChart } from "../components/TimeSeriesChart.tsx";
import { WeightPredictionSummary } from "../components/WeightPredictionSummary.tsx";
import { useBodyDays } from "../lib/bodyDaysContext.ts";
import { chartColors } from "../lib/chartTheme.ts";
import { trpc } from "../lib/trpc.ts";
import { useUnitConverter } from "../lib/unitContext.ts";
import { assertRows } from "../lib/utils.ts";

const trendRowSchema = z.object({
  avg_resting_hr: z.number().nullable(),
  avg_hrv: z.number().nullable(),
  avg_spo2: z.number().nullable(),
  avg_steps: z.number().nullable(),
  avg_active_energy: z.number().nullable(),
  avg_skin_temp: z.number().nullable(),
  stddev_resting_hr: z.number().nullable(),
  stddev_hrv: z.number().nullable(),
  stddev_spo2: z.number().nullable(),
  stddev_skin_temp: z.number().nullable(),
  latest_resting_hr: z.number().nullable(),
  latest_hrv: z.number().nullable(),
  latest_spo2: z.number().nullable(),
  latest_steps: z.number().nullable(),
  latest_active_energy: z.number().nullable(),
  latest_skin_temp: z.number().nullable(),
  latest_date: z.string().nullable(),
});

const dailyMetricRowSchema = z.object({
  date: z.string(),
  resting_hr: z.number().nullable(),
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
  unit: string;
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

export function BodyPage() {
  const units = useUnitConverter();
  const { days, setDays } = useBodyDays();
  const endDate = useMemo(() => formatDateYmd(new Date()), []);

  const trends = trpc.dailyMetrics.trends.useQuery({ days, endDate });
  const dailyMetrics = trpc.dailyMetrics.list.useQuery({ days, endDate });
  const hrvBaseline = trpc.dailyMetrics.hrvBaseline.useQuery({ days, endDate });
  const stressData = trpc.stress.scores.useQuery({ days, endDate });
  const smoothedWeight = trpc.bodyAnalytics.smoothedWeight.useQuery({
    days: Math.max(days, 90),
    endDate,
  });
  const weightPrediction = trpc.bodyAnalytics.weightPrediction.useQuery({
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
    }),
    [metrics],
  );

  const skinTempSeries = useMemo(() => buildSkinTempSeries(metrics, units), [metrics, units]);

  const healthMetrics = useMemo(() => {
    if (!trendData) return [];
    const entries: (MetricEntry | false)[] = [
      {
        label: "Resting HR",
        value: trendData.latest_resting_hr,
        avg: trendData.avg_resting_hr,
        stddev: trendData.stddev_resting_hr,
        unit: "bpm",
        lowerBetter: true,
      },
      {
        label: "Heart Rate Variability (HRV)",
        value: trendData.latest_hrv,
        avg: trendData.avg_hrv,
        stddev: trendData.stddev_hrv,
        unit: "ms",
        lowerBetter: false,
      },
      trendData.latest_spo2 != null && {
        label: "SpO2",
        value: trendData.latest_spo2,
        avg: trendData.avg_spo2,
        stddev: trendData.stddev_spo2,
        unit: "%",
      },
      trendData.latest_skin_temp != null && {
        label: "Skin Temp",
        value: units.convertTemperature(trendData.latest_skin_temp),
        avg:
          trendData.avg_skin_temp != null
            ? units.convertTemperature(trendData.avg_skin_temp)
            : null,
        stddev:
          trendData.stddev_skin_temp != null
            ? units.scaleTemperatureStddev(trendData.stddev_skin_temp)
            : null,
        unit: units.temperatureLabel,
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
      <HealthStatusBar metrics={healthMetrics} loading={trends.isLoading} />

      {/* HRV & Resting HR */}
      <PageSection title="Heart Rate Variability & Resting Heart Rate">
        <HrvBaselineChart data={hrvBaseline.data ?? []} loading={hrvBaseline.isLoading} />
      </PageSection>

      {/* Stress */}
      <PageSection title="Stress Monitor">
        <StressChart data={stressData.data} loading={stressData.isLoading} />
      </PageSection>

      {/* SpO2 & Skin Temp */}
      {(hasSpO2 || hasSkinTemp) && (
        <PageSection title={spo2TempTitle}>
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
        </PageSection>
      )}

      {/* Body Composition */}
      <PageSection title="Body Composition" card={false}>
        <div className="card p-2 sm:p-4 mb-4">
          <div className="mb-2 flex items-center justify-between">
            <h4 className="text-xs font-medium text-subtle uppercase">Weight Prediction</h4>
            <GoalWeightInput />
          </div>
          {weightPrediction.data?.ratePerWeek != null && (
            <WeightPredictionSummary prediction={weightPrediction.data} />
          )}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="card p-2 sm:p-4">
            <div className="mb-2 flex items-center gap-2">
              <h4 className="text-xs font-medium text-subtle uppercase">Weight Trend</h4>
              <ChartDescriptionTooltip description="This chart shows your smoothed body weight trend over time, with goal weight and forward projection when set." />
            </div>
            <SmoothedWeightChart
              data={smoothedWeight.data ?? []}
              prediction={weightPrediction.data}
              loading={smoothedWeight.isLoading}
            />
          </div>
          <div className="card p-2 sm:p-4">
            <div className="mb-2 flex items-center gap-2">
              <h4 className="text-xs font-medium text-subtle uppercase">Recomposition</h4>
              <ChartDescriptionTooltip description="This chart shows how fat mass and lean mass have changed so you can track body recomposition, not just scale weight." />
            </div>
            <BodyRecompositionChart data={bodyRecomp.data ?? []} loading={bodyRecomp.isLoading} />
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

      {!insightsQuery.isLoading && bodyInsights.length > 0 && (
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
