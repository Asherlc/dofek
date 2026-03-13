import { type ReactNode, useMemo, useState } from "react";
import { ActivityList } from "../components/ActivityList.tsx";
import { AnomalyAlertBanner } from "../components/AnomalyAlertBanner.tsx";
import { AppHeader } from "../components/AppHeader.tsx";
import { BodyRecompositionChart } from "../components/BodyRecompositionChart.tsx";
import { CorrelationCard, type Insight } from "../components/CorrelationCard.tsx";
import { HealthStatusBar } from "../components/HealthStatusBar.tsx";
import { HealthspanScoreCard } from "../components/HealthspanScoreCard.tsx";
import { HrvBaselineChart } from "../components/HrvBaselineChart.tsx";
import { NutritionChart } from "../components/NutritionChart.tsx";
import { SleepChart } from "../components/SleepChart.tsx";
import { SleepNeedCard } from "../components/SleepNeedCard.tsx";
import { SmoothedWeightChart } from "../components/SmoothedWeightChart.tsx";
import { StressChart } from "../components/StressChart.tsx";
import { TimeRangeSelector } from "../components/TimeRangeSelector.tsx";
import { TimeSeriesChart } from "../components/TimeSeriesChart.tsx";
import { WeeklyReportCard } from "../components/WeeklyReportCard.tsx";
import { useDashboardLayout } from "../lib/dashboardLayoutContext.ts";
import { trpc } from "../lib/trpc.ts";
import { useUnitSystem } from "../lib/unitContext.ts";
import { convertTemperature, temperatureLabel } from "../lib/units.ts";
import { assertRows } from "../lib/utils.ts";

type MetricEntry = {
  label: string;
  value: number | null;
  avg: number | null;
  stddev: number | null;
  unit: string;
  lowerBetter?: boolean;
};

interface TrendRow {
  avg_resting_hr: number | null;
  avg_hrv: number | null;
  avg_spo2: number | null;
  avg_steps: number | null;
  avg_active_energy: number | null;
  avg_skin_temp: number | null;
  stddev_resting_hr: number | null;
  stddev_hrv: number | null;
  stddev_spo2: number | null;
  stddev_skin_temp: number | null;
  latest_resting_hr: number | null;
  latest_hrv: number | null;
  latest_spo2: number | null;
  latest_steps: number | null;
  latest_active_energy: number | null;
  latest_skin_temp: number | null;
  latest_date: string | null;
}

interface DailyMetricRow {
  date: string;
  resting_hr: number | null;
  hrv: number | null;
  spo2_avg: number | null;
  skin_temp_c: number | null;
  steps: number | null;
  active_energy_kcal: number | null;
}

interface SleepRow {
  started_at: string;
  duration_minutes: number | null;
  deep_minutes: number | null;
  rem_minutes: number | null;
  light_minutes: number | null;
  awake_minutes: number | null;
  efficiency_pct: number | null;
}

interface NutritionDailyRow {
  date: string;
  calories: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  fiber_g: number | null;
}

interface ActivityRow {
  id: string;
  started_at: string;
  ended_at: string | null;
  activity_type: string;
  name: string | null;
  provider_id: string;
  source_providers: string[] | null;
}

/** Sections that render side-by-side in a 2-column grid. The key is the "primary" (left) section. */
const GRID_PAIRS: Record<string, string> = {
  weeklyReport: "sleepNeed",
  stress: "healthspan",
  spo2Temp: "steps",
};

/** Reverse lookup: secondary -> primary */
const GRID_PAIR_SECONDARY: Record<string, string> = {
  sleepNeed: "weeklyReport",
  healthspan: "stress",
  steps: "spo2Temp",
};

export function Dashboard() {
  const { unitSystem } = useUnitSystem();
  const { layout, toggleCollapsed, toggleHidden, moveSection } = useDashboardLayout();
  const [days, setDays] = useState(30);

  const trends = trpc.dailyMetrics.trends.useQuery({ days });
  const dailyMetrics = trpc.dailyMetrics.list.useQuery({ days });
  const activities = trpc.activity.list.useQuery({ days });
  const sleepData = trpc.sleep.list.useQuery({ days });
  const hrvBaseline = trpc.dailyMetrics.hrvBaseline.useQuery({ days });
  const nutritionData = trpc.nutrition.daily.useQuery({ days });
  const insightsQuery = trpc.insights.compute.useQuery({ days });
  const sleepNeed = trpc.sleepNeed.calculate.useQuery({});
  const stressData = trpc.stress.scores.useQuery({ days });
  const weeklyReport = trpc.weeklyReport.report.useQuery({ weeks: Math.ceil(days / 7) });
  const healthspan = trpc.healthspan.score.useQuery({ weeks: Math.max(Math.ceil(days / 7), 4) });
  const anomalyCheck = trpc.anomalyDetection.check.useQuery({});
  const smoothedWeight = trpc.bodyAnalytics.smoothedWeight.useQuery({ days: Math.max(days, 90) });
  const bodyRecomp = trpc.bodyAnalytics.recomposition.useQuery({ days: Math.max(days, 180) });
  // tRPC raw SQL result — typed assertion pending server-side typing
  const trendData = (trends.data ?? undefined) as TrendRow | undefined;

  const topInsights = useMemo(() => {
    const all = (insightsQuery.data ?? []) as Insight[];
    return all
      .filter((i) => i.confidence !== "insufficient")
      .sort((a, b) => Math.abs(b.effectSize) - Math.abs(a.effectSize))
      .slice(0, 2);
  }, [insightsQuery.data]);

  const healthMetrics = useMemo(
    () =>
      trendData
        ? ([
            {
              label: "Resting HR",
              value: trendData.latest_resting_hr,
              avg: trendData.avg_resting_hr,
              stddev: trendData.stddev_resting_hr,
              unit: "bpm",
              lowerBetter: true,
            },
            {
              label: "HRV",
              value: trendData.latest_hrv,
              avg: trendData.avg_hrv,
              stddev: trendData.stddev_hrv,
              unit: "ms",
            },
            trendData.latest_spo2 != null && {
              label: "SpO2",
              value: trendData.latest_spo2,
              avg: trendData.avg_spo2,
              stddev: trendData.stddev_spo2,
              unit: "%",
            },
            {
              label: "Steps",
              value: trendData.latest_steps,
              avg: trendData.avg_steps,
              stddev: null,
              unit: "",
            },
            {
              label: "Active Energy",
              value: trendData.latest_active_energy,
              avg: trendData.avg_active_energy,
              stddev: null,
              unit: "kcal",
            },
            trendData.latest_skin_temp != null && {
              label: "Skin Temp",
              value: convertTemperature(trendData.latest_skin_temp, unitSystem),
              avg:
                trendData.avg_skin_temp != null
                  ? convertTemperature(trendData.avg_skin_temp, unitSystem)
                  : null,
              stddev: trendData.stddev_skin_temp,
              unit: temperatureLabel(unitSystem),
            },
          ].filter(Boolean) as MetricEntry[])
        : [],
    [trendData, unitSystem],
  );

  const metrics = assertRows<DailyMetricRow>(dailyMetrics.data);

  const hasSpO2 = metrics.some((d) => d.spo2_avg != null);
  const hasSkinTemp = metrics.some((d) => d.skin_temp_c != null);

  const spo2Series = useMemo(
    () => ({
      name: "SpO2",
      data: metrics.map((d) => [d.date, d.spo2_avg] as [string, number | null]),
      color: "#3b82f6",
      areaStyle: true,
    }),
    [metrics],
  );

  const skinTempSeries = useMemo(
    () => ({
      name: "Skin Temp",
      data: metrics.map(
        (d) =>
          [
            d.date,
            d.skin_temp_c != null ? convertTemperature(d.skin_temp_c, unitSystem) : null,
          ] as [string, number | null],
      ),
      color: "#f59e0b",
    }),
    [metrics, unitSystem],
  );

  const stepsSeries = useMemo(
    () => ({
      name: "Steps",
      data: metrics.map((d) => [d.date, d.steps] as [string, number | null]),
      color: "#8b5cf6",
      areaStyle: true,
    }),
    [metrics],
  );

  // Build a map of section ID -> rendered content
  const sectionContent: Record<string, { title: string; subtitle: string; content: ReactNode }> = {
    healthMonitor: {
      title: "Health Monitor",
      subtitle: "Today's values vs. rolling average",
      content: <HealthStatusBar metrics={healthMetrics} loading={trends.isLoading} />,
    },
    topInsights: {
      title: "Top Insights",
      subtitle: "Strongest correlations in your data",
      content: insightsQuery.isLoading ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="h-48 rounded-lg bg-zinc-800 animate-pulse" />
          <div className="h-48 rounded-lg bg-zinc-800 animate-pulse" />
        </div>
      ) : topInsights.length > 0 ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {topInsights.map((insight) => (
            <CorrelationCard key={insight.id} insight={insight} />
          ))}
        </div>
      ) : (
        <p className="text-sm text-zinc-500">
          Not enough data to surface insights yet. Check back after a few more days of tracking.
        </p>
      ),
    },
    weeklyReport: {
      title: "Weekly Performance",
      subtitle: "Strain balance, sleep vs average, key vitals",
      content: <WeeklyReportCard data={weeklyReport.data} loading={weeklyReport.isLoading} />,
    },
    sleepNeed: {
      title: "Sleep Coach",
      subtitle: "Personalized sleep need based on strain and debt",
      content: <SleepNeedCard data={sleepNeed.data} loading={sleepNeed.isLoading} />,
    },
    stress: {
      title: "Stress Monitor",
      subtitle: "Daily stress from HR/HRV deviation vs personal baseline",
      content: (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-2 sm:p-4">
          <StressChart data={stressData.data} loading={stressData.isLoading} />
        </div>
      ),
    },
    healthspan: {
      title: "Healthspan",
      subtitle: "Composite longevity score from 9 health metrics",
      content: <HealthspanScoreCard data={healthspan.data} loading={healthspan.isLoading} />,
    },
    hrvRhr: {
      title: "Heart Rate Variability & Resting HR",
      subtitle: "60-day baseline band with 7-day rolling average",
      content: (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-2 sm:p-4">
          <HrvBaselineChart
            data={
              (hrvBaseline.data ?? []) as {
                date: string;
                hrv: number | null;
                resting_hr: number | null;
                mean_60d: number | null;
                sd_60d: number | null;
                mean_7d: number | null;
              }[]
            }
            loading={hrvBaseline.isLoading}
          />
        </div>
      ),
    },
    spo2Temp: {
      title: "SpO2 & Skin Temperature",
      subtitle: "Blood oxygen saturation and wrist skin temperature over time",
      content:
        hasSpO2 || hasSkinTemp ? (
          <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-2 sm:p-4">
            <TimeSeriesChart
              series={[...(hasSpO2 ? [spo2Series] : []), ...(hasSkinTemp ? [skinTempSeries] : [])]}
              height={200}
              yAxis={[{ name: "SpO2 (%)", min: 90 }, { name: temperatureLabel(unitSystem) }]}
              loading={dailyMetrics.isLoading}
            />
          </div>
        ) : null,
    },
    steps: {
      title: "Daily Steps",
      subtitle: "Total daily step count over time",
      content: (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-2 sm:p-4">
          <TimeSeriesChart
            series={[stepsSeries]}
            height={200}
            yAxis={[{ name: "steps" }]}
            loading={dailyMetrics.isLoading}
          />
        </div>
      ),
    },
    sleep: {
      title: "Sleep",
      subtitle: `Stage breakdown (${days} days)`,
      content: (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-2 sm:p-4">
          <SleepChart data={assertRows<SleepRow>(sleepData.data)} loading={sleepData.isLoading} />
        </div>
      ),
    },
    nutrition: {
      title: "Nutrition",
      subtitle: `Calories & macros (${days} days)`,
      content: (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-2 sm:p-4">
          <NutritionChart
            data={assertRows<NutritionDailyRow>(nutritionData.data)}
            loading={nutritionData.isLoading}
          />
        </div>
      ),
    },
    bodyComp: {
      title: "Body Composition",
      subtitle: "Smoothed weight trend and fat/lean mass recomposition",
      content: (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-2 sm:p-4">
            <h3 className="text-xs font-medium text-zinc-500 uppercase mb-2">Weight Trend</h3>
            <SmoothedWeightChart
              data={smoothedWeight.data ?? []}
              loading={smoothedWeight.isLoading}
            />
          </div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-2 sm:p-4">
            <h3 className="text-xs font-medium text-zinc-500 uppercase mb-2">Recomposition</h3>
            <BodyRecompositionChart data={bodyRecomp.data ?? []} loading={bodyRecomp.isLoading} />
          </div>
        </div>
      ),
    },
    activities: {
      title: "Recent Activities",
      subtitle: `Last ${days} days`,
      content: (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-2 sm:p-4">
          <ActivityList
            activities={assertRows<ActivityRow>(activities.data)}
            loading={activities.isLoading}
          />
        </div>
      ),
    },
  };

  // Build the ordered list of sections to render, skipping hidden and already-rendered (pair secondaries)
  const rendered = new Set<string>();
  const orderedElements: ReactNode[] = [];

  for (const id of layout.order) {
    if (rendered.has(id) || layout.hidden.includes(id)) continue;

    const section = sectionContent[id];
    if (!section) continue;

    // Check if this section is the secondary of a grid pair (its primary should render it)
    if (GRID_PAIR_SECONDARY[id]) continue;

    const pairId = GRID_PAIRS[id];
    const pairSection = pairId ? sectionContent[pairId] : undefined;
    const pairHidden = pairId ? layout.hidden.includes(pairId) : false;

    rendered.add(id);
    if (pairId) rendered.add(pairId);

    if (pairId && pairSection && !pairHidden) {
      // Render as a grid pair
      const resolvedPairId = pairId;
      orderedElements.push(
        <div key={`pair-${id}`} className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <CollapsibleSection
            id={id}
            title={section.title}
            subtitle={section.subtitle}
            collapsed={layout.collapsed[id]}
            onToggle={() => toggleCollapsed(id)}
            onMoveUp={() => moveSection(id, "up")}
            onMoveDown={() => moveSection(id, "down")}
            onHide={() => toggleHidden(id)}
          >
            {section.content}
          </CollapsibleSection>
          <CollapsibleSection
            id={resolvedPairId}
            title={pairSection.title}
            subtitle={pairSection.subtitle}
            collapsed={layout.collapsed[resolvedPairId]}
            onToggle={() => toggleCollapsed(resolvedPairId)}
            onMoveUp={() => moveSection(resolvedPairId, "up")}
            onMoveDown={() => moveSection(resolvedPairId, "down")}
            onHide={() => toggleHidden(resolvedPairId)}
          >
            {pairSection.content}
          </CollapsibleSection>
        </div>,
      );
    } else {
      // Render standalone (including when pair is hidden)
      orderedElements.push(
        <CollapsibleSection
          key={id}
          id={id}
          title={section.title}
          subtitle={section.subtitle}
          collapsed={layout.collapsed[id]}
          onToggle={() => toggleCollapsed(id)}
          onMoveUp={() => moveSection(id, "up")}
          onMoveDown={() => moveSection(id, "down")}
          onHide={() => toggleHidden(id)}
        >
          {section.content}
        </CollapsibleSection>,
      );
    }
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 overflow-x-hidden">
      <AppHeader>
        <div className="flex items-center gap-2 sm:gap-4 shrink-0">
          <p className="text-xs text-zinc-500 hidden sm:block">
            {trendData?.latest_date
              ? `Latest: ${new Date(trendData.latest_date).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}`
              : ""}
          </p>
          <TimeRangeSelector days={days} onChange={setDays} />
        </div>
      </AppHeader>

      <main className="mx-auto max-w-7xl px-3 sm:px-6 py-4 sm:py-6 space-y-6 sm:space-y-8">
        {/* Anomaly Alert — always at the top, not reorderable */}
        <AnomalyAlertBanner
          anomalies={anomalyCheck.data?.anomalies ?? []}
          loading={anomalyCheck.isLoading}
        />

        {orderedElements}
      </main>
    </div>
  );
}

function CollapsibleSection({
  title,
  subtitle,
  collapsed,
  onToggle,
  onMoveUp,
  onMoveDown,
  onHide,
  children,
}: {
  id?: string;
  title: string;
  subtitle?: string;
  collapsed?: boolean;
  onToggle: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onHide?: () => void;
  children: React.ReactNode;
}) {
  return (
    <section className="group/section">
      <div className="mb-3 flex items-center gap-2 min-h-[44px]">
        <button
          type="button"
          onClick={onToggle}
          className="flex items-center gap-2 group cursor-pointer text-left flex-1"
        >
          <span
            className={`text-zinc-600 text-xs transition-transform ${collapsed ? "" : "rotate-90"}`}
          >
            ▶
          </span>
          <div>
            <h2 className="text-sm font-medium text-zinc-400 uppercase tracking-wider group-hover:text-zinc-300 transition-colors">
              {title}
            </h2>
            {subtitle && <p className="text-xs text-zinc-600 mt-0.5">{subtitle}</p>}
          </div>
        </button>

        {/* Layout controls — visible on hover */}
        <div className="flex items-center gap-0.5 opacity-0 group-hover/section:opacity-100 transition-opacity">
          {onMoveUp && (
            <button
              type="button"
              onClick={onMoveUp}
              className="p-1 text-zinc-600 hover:text-zinc-300 transition-colors cursor-pointer"
              title="Move up"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 16 16"
                fill="currentColor"
                className="w-3.5 h-3.5"
              >
                <title>Move up</title>
                <path
                  fillRule="evenodd"
                  d="M8 3.5a.75.75 0 0 1 .75.75v5.19l2.22-2.22a.75.75 0 1 1 1.06 1.06l-3.5 3.5a.75.75 0 0 1-1.06 0l-3.5-3.5a.75.75 0 0 1 1.06-1.06l2.22 2.22V4.25A.75.75 0 0 1 8 3.5Z"
                  clipRule="evenodd"
                  transform="rotate(180 8 8)"
                />
              </svg>
            </button>
          )}
          {onMoveDown && (
            <button
              type="button"
              onClick={onMoveDown}
              className="p-1 text-zinc-600 hover:text-zinc-300 transition-colors cursor-pointer"
              title="Move down"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 16 16"
                fill="currentColor"
                className="w-3.5 h-3.5"
              >
                <title>Move down</title>
                <path
                  fillRule="evenodd"
                  d="M8 3.5a.75.75 0 0 1 .75.75v5.19l2.22-2.22a.75.75 0 1 1 1.06 1.06l-3.5 3.5a.75.75 0 0 1-1.06 0l-3.5-3.5a.75.75 0 0 1 1.06-1.06l2.22 2.22V4.25A.75.75 0 0 1 8 3.5Z"
                  clipRule="evenodd"
                />
              </svg>
            </button>
          )}
          {onHide && (
            <button
              type="button"
              onClick={onHide}
              className="p-1 text-zinc-600 hover:text-zinc-300 transition-colors cursor-pointer"
              title="Hide section"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 16 16"
                fill="currentColor"
                className="w-3.5 h-3.5"
              >
                <title>Hide section</title>
                <path d="M3.28 2.22a.75.75 0 0 0-1.06 1.06l10.5 10.5a.75.75 0 1 0 1.06-1.06l-1.527-1.527A7.052 7.052 0 0 0 14.5 8c-.972-2.545-3.61-5-6.5-5a6.2 6.2 0 0 0-3.02.79L3.28 2.22Zm3.196 3.195 1.135 1.136A1.502 1.502 0 0 1 9.45 8.389l1.136 1.135a3 3 0 0 0-4.11-4.109Z" />
                <path d="M5.093 7.124l3.783 3.783a3 3 0 0 1-3.783-3.783ZM1.5 8c.572-1.497 1.712-3.01 3.14-3.935L3.31 2.735C1.618 3.87.346 5.513 0 8c.972 2.545 3.61 5 6.5 5a6.59 6.59 0 0 0 2.91-.67l-1.452-1.453A4.98 4.98 0 0 1 6.5 11.5c-2.1 0-3.87-1.66-5-3.5Z" />
              </svg>
            </button>
          )}
        </div>
      </div>
      {!collapsed && children}
    </section>
  );
}
