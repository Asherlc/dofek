import { useMemo, useState } from "react";
import { z } from "zod";
import { AppHeader } from "../components/AppHeader.tsx";
import { BodyRecompositionChart } from "../components/BodyRecompositionChart.tsx";
import { ChartDescriptionTooltip } from "../components/ChartDescriptionTooltip.tsx";
import {
  CorrelationCard,
  CorrelationCardSkeleton,
  type Insight,
} from "../components/CorrelationCard.tsx";
import { HealthStatusBar } from "../components/HealthStatusBar.tsx";
import { HrvBaselineChart } from "../components/HrvBaselineChart.tsx";
import { SmoothedWeightChart } from "../components/SmoothedWeightChart.tsx";
import { StressChart } from "../components/StressChart.tsx";
import { TimeRangeSelector } from "../components/TimeRangeSelector.tsx";
import { TimeSeriesChart } from "../components/TimeSeriesChart.tsx";
import { chartColors } from "../lib/chartTheme.ts";
import { trpc } from "../lib/trpc.ts";
import { useUnitSystem } from "../lib/unitContext.ts";
import {
  convertTemperature,
  scaleTemperatureStddev,
  temperatureLabel,
  type UnitSystem,
} from "../lib/units.ts";
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
  unitSystem: UnitSystem,
) {
  return {
    name: "Skin Temp",
    data: metrics.map((d): [string, number | null] => [
      d.date,
      d.skin_temp_c != null ? convertTemperature(d.skin_temp_c, unitSystem) : null,
    ]),
    color: chartColors.amber,
    yAxisIndex: 1 as const,
  };
}

export function BodyPage() {
  const { unitSystem } = useUnitSystem();
  const [days, setDays] = useState(30);

  const trends = trpc.dailyMetrics.trends.useQuery({ days });
  const dailyMetrics = trpc.dailyMetrics.list.useQuery({ days });
  const hrvBaseline = trpc.dailyMetrics.hrvBaseline.useQuery({ days });
  const stressData = trpc.stress.scores.useQuery({ days });
  const smoothedWeight = trpc.bodyAnalytics.smoothedWeight.useQuery({ days: Math.max(days, 90) });
  const bodyRecomp = trpc.bodyAnalytics.recomposition.useQuery({ days: Math.max(days, 180) });
  const insightsQuery = trpc.insights.compute.useQuery({ days: Math.max(days, 90) });

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

  const skinTempSeries = useMemo(
    () => buildSkinTempSeries(metrics, unitSystem),
    [metrics, unitSystem],
  );

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
        value: convertTemperature(trendData.latest_skin_temp, unitSystem),
        avg:
          trendData.avg_skin_temp != null
            ? convertTemperature(trendData.avg_skin_temp, unitSystem)
            : null,
        stddev:
          trendData.stddev_skin_temp != null
            ? scaleTemperatureStddev(trendData.stddev_skin_temp, unitSystem)
            : null,
        unit: temperatureLabel(unitSystem),
      },
    ];
    return entries.filter((entry): entry is MetricEntry => entry !== false);
  }, [trendData, unitSystem]);

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
      ? [{ name: "SpO2 (%)", min: 90 }, { name: temperatureLabel(unitSystem) }]
      : hasSpO2
        ? [{ name: "SpO2 (%)", min: 90 }]
        : [{ name: temperatureLabel(unitSystem) }];

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 overflow-x-hidden">
      <AppHeader>
        <TimeRangeSelector days={days} onChange={setDays} />
      </AppHeader>
      <main className="mx-auto max-w-7xl px-3 sm:px-6 py-4 sm:py-6 space-y-6 sm:space-y-8">
        <div>
          <h2 className="text-sm font-medium text-zinc-400 uppercase tracking-wider">Body</h2>
          <p className="text-xs text-zinc-600 mt-0.5">
            Recovery metrics, vitals, and body composition
          </p>
        </div>

        {/* Health Status Bar */}
        <HealthStatusBar metrics={healthMetrics} loading={trends.isLoading} />

        {/* HRV & Resting HR */}
        <section>
          <h3 className="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-3">
            Heart Rate Variability & Resting Heart Rate
          </h3>
          <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-2 sm:p-4">
            <HrvBaselineChart data={hrvBaseline.data ?? []} loading={hrvBaseline.isLoading} />
          </div>
        </section>

        {/* Stress */}
        <section>
          <h3 className="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-3">
            Stress Monitor
          </h3>
          <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-2 sm:p-4">
            <StressChart data={stressData.data} loading={stressData.isLoading} />
          </div>
        </section>

        {/* SpO2 & Skin Temp */}
        {(hasSpO2 || hasSkinTemp) && (
          <section>
            <h3 className="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-3">
              {spo2TempTitle}
            </h3>
            <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-2 sm:p-4">
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
            </div>
          </section>
        )}

        {/* Body Composition */}
        <section>
          <h3 className="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-3">
            Body Composition
          </h3>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-2 sm:p-4">
              <div className="mb-2 flex items-center gap-2">
                <h4 className="text-xs font-medium text-zinc-500 uppercase">Weight Trend</h4>
                <ChartDescriptionTooltip description="This chart shows your smoothed body weight trend over time to highlight your underlying direction." />
              </div>
              <SmoothedWeightChart
                data={smoothedWeight.data ?? []}
                loading={smoothedWeight.isLoading}
              />
            </div>
            <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-2 sm:p-4">
              <div className="mb-2 flex items-center gap-2">
                <h4 className="text-xs font-medium text-zinc-500 uppercase">Recomposition</h4>
                <ChartDescriptionTooltip description="This chart shows how fat mass and lean mass have changed so you can track body recomposition, not just scale weight." />
              </div>
              <BodyRecompositionChart data={bodyRecomp.data ?? []} loading={bodyRecomp.isLoading} />
            </div>
          </div>
        </section>

        {/* Body Insights */}
        {insightsQuery.isLoading && (
          <section>
            <h3 className="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-3">
              Body Insights
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {["b1", "b2"].map((id) => (
                <CorrelationCardSkeleton key={id} />
              ))}
            </div>
          </section>
        )}

        {!insightsQuery.isLoading && bodyInsights.length > 0 && (
          <section>
            <h3 className="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-3">
              Body Insights
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {bodyInsights.map((insight) => (
                <CorrelationCard key={insight.id} insight={insight} />
              ))}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
