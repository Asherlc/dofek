import { Link } from "@tanstack/react-router";
import { type ReactNode, useCallback, useMemo, useState } from "react";
import { z } from "zod";
import { ActivityList } from "../components/ActivityList.tsx";
import { AnomalyAlertBanner } from "../components/AnomalyAlertBanner.tsx";
import { BodyRecompositionChart } from "../components/BodyRecompositionChart.tsx";
import { ChartDescriptionTooltip } from "../components/ChartDescriptionTooltip.tsx";
import { CorrelationCard, type Insight } from "../components/CorrelationCard.tsx";
import { HealthStatusBar } from "../components/HealthStatusBar.tsx";
import { HealthspanScoreCard } from "../components/HealthspanScoreCard.tsx";
import { HrvBaselineChart } from "../components/HrvBaselineChart.tsx";
import { NextWorkoutCard } from "../components/NextWorkoutCard.tsx";
import { NutritionChart } from "../components/NutritionChart.tsx";
import { OnboardingWelcome } from "../components/OnboardingWelcome.tsx";
import { PageLayout } from "../components/PageLayout.tsx";
import { SleepChart } from "../components/SleepChart.tsx";
import { SleepNeedCard } from "../components/SleepNeedCard.tsx";
import { SmoothedWeightChart } from "../components/SmoothedWeightChart.tsx";
import { StrainCard } from "../components/StrainCard.tsx";
import { StressChart } from "../components/StressChart.tsx";
import { TimeRangeSelector } from "../components/TimeRangeSelector.tsx";
import { TimeSeriesChart } from "../components/TimeSeriesChart.tsx";
import { WeeklyReportCard } from "../components/WeeklyReportCard.tsx";
import { useAutoSync } from "../hooks/useAutoSync.ts";
import { useScrollReveal } from "../hooks/useScrollReveal.ts";
import { chartColors } from "../lib/chartTheme.ts";
import { useDashboardLayout } from "../lib/dashboardLayoutContext.ts";
import { trpc } from "../lib/trpc.ts";
import { useUnitConverter } from "../lib/unitContext.ts";
import type { UnitConverter } from "../lib/units.ts";
import { useOnboarding } from "../lib/useOnboarding.ts";
import { assertRows } from "../lib/utils.ts";

type MetricEntry = {
  label: string;
  value: number | null;
  avg: number | null;
  stddev: number | null;
  unit: string;
  lowerBetter?: boolean;
};

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
type TrendRow = z.infer<typeof trendRowSchema>;

const dailyMetricRowSchema = z.object({
  date: z.string(),
  resting_hr: z.number().nullable(),
  hrv: z.number().nullable(),
  spo2_avg: z.number().nullable(),
  skin_temp_c: z.number().nullable(),
  steps: z.number().nullable(),
  active_energy_kcal: z.number().nullable(),
});

const sleepRowSchema = z.object({
  started_at: z.string(),
  duration_minutes: z.number().nullable(),
  deep_minutes: z.number().nullable(),
  rem_minutes: z.number().nullable(),
  light_minutes: z.number().nullable(),
  awake_minutes: z.number().nullable(),
  efficiency_pct: z.number().nullable(),
});

const nutritionDailyRowSchema = z.object({
  date: z.string(),
  calories: z.number().nullable(),
  protein_g: z.number().nullable(),
  carbs_g: z.number().nullable(),
  fat_g: z.number().nullable(),
  fiber_g: z.number().nullable(),
});

const activityRowSchema = z.object({
  id: z.string(),
  started_at: z.string(),
  ended_at: z.string().nullable(),
  activity_type: z.string(),
  name: z.string().nullable(),
  provider_id: z.string(),
  source_providers: z.array(z.string()).nullable(),
  distance_meters: z.number().nullable().optional(),
  calories: z.number().nullable().optional(),
});

export function healthMonitorSubtitle(latestDate: string | null | undefined): string {
  if (!latestDate) return "Today's values vs. rolling average";
  const today = new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD in local tz
  if (latestDate === today) return "Today's values vs. rolling average";
  const dateLabel = new Date(`${latestDate}T00:00:00`).toLocaleDateString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
  });
  return `Latest values from ${dateLabel} — not yet updated today`;
}

/** Sections that render side-by-side in a 2-column grid. The key is the "primary" (left) section. */
const GRID_PAIRS: Record<string, string> = {
  strain: "nextWorkout",
  weeklyReport: "sleepNeed",
  stress: "healthspan",
  spo2Temp: "steps",
};

/** Reverse lookup: secondary -> primary */
const GRID_PAIR_SECONDARY: Record<string, string> = {
  nextWorkout: "strain",
  sleepNeed: "weeklyReport",
  healthspan: "stress",
  steps: "spo2Temp",
};

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
    data: metrics.map((d): [string, number | null] => [
      d.date,
      d.skin_temp_c != null ? units.convertTemperature(d.skin_temp_c) : null,
    ]),
    color: chartColors.amber,
    yAxisIndex: 1 as const,
  };
}

export const DASHBOARD_SECTION_IDS = new Set([
  "healthMonitor",
  "strain",
  "weeklyReport",
  "sleepNeed",
  "nextWorkout",
  "spo2Temp",
  "steps",
  "sleep",
  "activities",
]);

export function Dashboard() {
  const units = useUnitConverter();
  const { layout, toggleCollapsed, toggleHidden, moveSection } = useDashboardLayout();
  const [days, setDaysRaw] = useState(30);
  const [activityPage, setActivityPage] = useState(0);
  const activityPageSize = 20;
  const setDays = useCallback((d: number) => {
    setDaysRaw(d);
    setActivityPage(0);
  }, []);
  const onboarding = useOnboarding();
  const today = new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD in client tz

  const trends = trpc.dailyMetrics.trends.useQuery({ days, today });
  const dailyMetrics = trpc.dailyMetrics.list.useQuery({ days, today });
  const activities = trpc.activity.list.useQuery({
    days,
    limit: activityPageSize,
    offset: activityPage * activityPageSize,
  });
  const sleepData = trpc.sleep.list.useQuery({ days });
  const hrvBaseline = trpc.dailyMetrics.hrvBaseline.useQuery({ days, today });
  const nutritionData = trpc.nutrition.daily.useQuery({ days });
  const insightsQuery = trpc.insights.compute.useQuery({ days });
  const sleepNeed = trpc.sleepNeed.calculate.useQuery();
  const stressData = trpc.stress.scores.useQuery({ days });
  const weeklyReport = trpc.weeklyReport.report.useQuery({ weeks: Math.ceil(days / 7) });
  const nextWorkout = trpc.training.nextWorkout.useQuery();
  const workloadRatio = trpc.recovery.workloadRatio.useQuery({ days });
  const healthspan = trpc.healthspan.score.useQuery({ weeks: Math.max(Math.ceil(days / 7), 4) });
  const anomalyCheck = trpc.anomalyDetection.check.useQuery({});
  const smoothedWeight = trpc.bodyAnalytics.smoothedWeight.useQuery({ days: Math.max(days, 90) });
  const bodyRecomp = trpc.bodyAnalytics.recomposition.useQuery({ days: Math.max(days, 180) });
  const trendData: TrendRow | undefined = trends.data
    ? trendRowSchema.parse(trends.data)
    : undefined;

  // Auto-sync when data is stale (API providers only — HealthKit requires iOS)
  useAutoSync(trendData?.latest_date);

  const topInsights = useMemo(() => {
    const all: Insight[] = insightsQuery.data ?? [];
    return all
      .filter((i) => i.confidence !== "insufficient")
      .sort((a, b) => Math.abs(b.effectSize) - Math.abs(a.effectSize))
      .slice(0, 2);
  }, [insightsQuery.data]);

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

  const spo2TempConfig = spo2TempSectionConfig(hasSpO2, hasSkinTemp, units);

  const stepsSeries = useMemo(
    () => ({
      name: "Steps",
      data: metrics.map((d): [string, number | null] => [d.date, d.steps]),
      color: chartColors.purple,
      areaStyle: true,
    }),
    [metrics],
  );

  // Build a map of section ID -> rendered content
  const sectionContent: Record<string, { title: string; subtitle: string; content: ReactNode }> = {
    healthMonitor: {
      title: "Health Monitor",
      subtitle: healthMonitorSubtitle(trendData?.latest_date),
      content: <HealthStatusBar metrics={healthMetrics} loading={trends.isLoading} />,
    },
    topInsights: {
      title: "Top Insights",
      subtitle: "Strongest correlations in your data",
      content: insightsQuery.isLoading ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="h-48 rounded-lg bg-skeleton animate-pulse" />
          <div className="h-48 rounded-lg bg-skeleton animate-pulse" />
        </div>
      ) : topInsights.length > 0 ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {topInsights.map((insight) => (
            <CorrelationCard key={insight.id} insight={insight} />
          ))}
        </div>
      ) : (
        <p className="text-sm text-subtle">
          Not enough data to surface insights yet. Check back after a few more days of tracking.
        </p>
      ),
    },
    weeklyReport: {
      title: "Weekly Performance",
      subtitle: "Strain balance, sleep vs average, key vitals",
      content: <WeeklyReportCard data={weeklyReport.data} loading={weeklyReport.isLoading} />,
    },
    strain: {
      title: "Strain",
      subtitle: "Current training strain on a 0-21 scale with acute/chronic workload balance",
      content: <StrainCard data={workloadRatio.data} loading={workloadRatio.isLoading} />,
    },
    nextWorkout: {
      title: "Next Workout",
      subtitle: "Daily recommendation based on readiness and training balance",
      content: <NextWorkoutCard data={nextWorkout.data} loading={nextWorkout.isLoading} />,
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
        <div className="card p-2 sm:p-4">
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
        <div className="card p-2 sm:p-4">
          <HrvBaselineChart data={hrvBaseline.data ?? []} loading={hrvBaseline.isLoading} />
        </div>
      ),
    },
    spo2Temp: {
      title: spo2TempConfig.title,
      subtitle: spo2TempConfig.subtitle,
      content:
        hasSpO2 || hasSkinTemp ? (
          <div className="card p-2 sm:p-4">
            <TimeSeriesChart
              series={[
                ...(hasSpO2 ? [spo2Series] : []),
                ...(hasSkinTemp
                  ? [hasSpO2 ? skinTempSeries : { ...skinTempSeries, yAxisIndex: 0 as const }]
                  : []),
              ]}
              height={200}
              yAxis={spo2TempConfig.yAxis}
              loading={dailyMetrics.isLoading}
            />
          </div>
        ) : null,
    },
    steps: {
      title: "Daily Steps",
      subtitle: "Total daily step count over time",
      content: (
        <div className="card p-2 sm:p-4">
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
        <div className="card p-2 sm:p-4">
          <SleepChart
            data={assertRows(sleepData.data, sleepRowSchema)}
            loading={sleepData.isLoading}
          />
        </div>
      ),
    },
    nutrition: {
      title: "Nutrition",
      subtitle: `Calories & macros (${days} days)`,
      content: (
        <div className="card p-2 sm:p-4">
          <NutritionChart
            data={assertRows(nutritionData.data, nutritionDailyRowSchema)}
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
          <div className="card p-2 sm:p-4">
            <div className="mb-2 flex items-center gap-2">
              <h3 className="text-xs font-medium text-subtle uppercase">Weight Trend</h3>
              <ChartDescriptionTooltip description="This chart shows your smoothed body weight trend over time to highlight your underlying direction." />
            </div>
            <SmoothedWeightChart
              data={smoothedWeight.data ?? []}
              loading={smoothedWeight.isLoading}
            />
          </div>
          <div className="card p-2 sm:p-4">
            <div className="mb-2 flex items-center gap-2">
              <h3 className="text-xs font-medium text-subtle uppercase">Recomposition</h3>
              <ChartDescriptionTooltip description="This chart shows how fat mass and lean mass have changed so you can track body recomposition, not just scale weight." />
            </div>
            <BodyRecompositionChart data={bodyRecomp.data ?? []} loading={bodyRecomp.isLoading} />
          </div>
        </div>
      ),
    },
    activities: {
      title: "Recent Activities",
      subtitle: `Last ${days} days`,
      content: (
        <div className="card p-2 sm:p-4">
          <ActivityList
            activities={assertRows(activities.data?.items, activityRowSchema)}
            loading={activities.isLoading}
            totalCount={activities.data?.totalCount}
            page={activityPage}
            pageSize={activityPageSize}
            onPageChange={setActivityPage}
          />
        </div>
      ),
    },
  };

  // Build the ordered list of sections to render, skipping hidden and already-rendered (pair secondaries)
  const rendered = new Set<string>();
  const orderedElements: ReactNode[] = [];
  let sectionIndex = 0;

  for (const id of layout.order) {
    if (!DASHBOARD_SECTION_IDS.has(id)) continue;
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

    const currentIndex = sectionIndex++;

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
            staggerIndex={currentIndex}
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
            staggerIndex={currentIndex + 1}
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
          staggerIndex={currentIndex}
        >
          {section.content}
        </CollapsibleSection>,
      );
    }
  }

  return (
    <PageLayout
      headerChildren={
        <div className="flex items-center gap-2 sm:gap-4 shrink-0">
          <p className="text-xs text-subtle hidden sm:block">
            {trendData?.latest_date
              ? `Latest: ${new Date(trendData.latest_date).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}`
              : ""}
          </p>
          <TimeRangeSelector days={days} onChange={setDays} />
        </div>
      }
    >
      {/* Onboarding — shown to new users with no connected providers */}
      {onboarding.showOnboarding && (
        <OnboardingWelcome onDismiss={onboarding.dismiss} providers={onboarding.providers} />
      )}

      {/* Anomaly Alert — always at the top, not reorderable */}
      <AnomalyAlertBanner
        anomalies={anomalyCheck.data?.anomalies ?? []}
        loading={anomalyCheck.isLoading}
      />

      <section>
        <h2 className="text-sm font-medium text-muted uppercase tracking-wider mb-1">
          Detailed Views
        </h2>
        <p className="text-xs text-dim mb-3">
          Deep dives are available in dedicated pages, not on the dashboard.
        </p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          <DashboardLink to="/training" label="Training" />
          <DashboardLink to="/sleep" label="Sleep" />
          <DashboardLink to="/nutrition" label="Nutrition" />
          <DashboardLink to="/body" label="Body" />
        </div>
      </section>

      {orderedElements}
    </PageLayout>
  );
}

function DashboardLink({ to, label }: { to: string; label: string }) {
  return (
    <Link
      to={to}
      className="card px-3 py-2 text-sm text-foreground hover:text-foreground hover:border-border-strong transition-colors"
    >
      {label}
    </Link>
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
  staggerIndex = 0,
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
  staggerIndex?: number;
}) {
  const revealRef = useScrollReveal<HTMLElement>(staggerIndex);
  return (
    <section ref={revealRef} className="group/section reveal">
      <div className="mb-3 flex items-center gap-2 min-h-[44px]">
        <button
          type="button"
          onClick={onToggle}
          className="flex items-center gap-2 group cursor-pointer text-left flex-1"
        >
          <span className={`text-dim text-xs transition-transform ${collapsed ? "" : "rotate-90"}`}>
            ▶
          </span>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-medium text-muted uppercase tracking-wider group-hover:text-foreground transition-colors">
                {title}
              </h2>
              {subtitle && <ChartDescriptionTooltip description={subtitle} />}
            </div>
            {subtitle && <p className="text-xs text-dim mt-0.5">{subtitle}</p>}
          </div>
        </button>

        {/* Layout controls — visible on hover */}
        <div className="flex items-center gap-0.5 opacity-0 group-hover/section:opacity-100 transition-opacity">
          {onMoveUp && (
            <button
              type="button"
              onClick={onMoveUp}
              className="p-1 text-dim hover:text-foreground transition-colors cursor-pointer"
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
              className="p-1 text-dim hover:text-foreground transition-colors cursor-pointer"
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
              className="p-1 text-dim hover:text-foreground transition-colors cursor-pointer"
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
