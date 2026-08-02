import { formatNumber } from "@dofek/format/format";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { ActivityList } from "../../components/ActivityList.tsx";
import { ActivityVariabilityTable } from "../../components/ActivityVariabilityTable.tsx";
import { AerobicEfficiencyChart } from "../../components/AerobicEfficiencyChart.tsx";
import { ChartDescriptionTooltip } from "../../components/ChartDescriptionTooltip.tsx";
import { EftpTrendChart } from "../../components/EftpTrendChart.tsx";
import { PmcChart } from "../../components/PmcChart.tsx";
import { PowerCurveChart } from "../../components/PowerCurveChart.tsx";
import { QueryStatePanel } from "../../components/QueryStatePanel.tsx";
import { VerticalAscentChart } from "../../components/VerticalAscentChart.tsx";
import { chartColors, chartThemeColors } from "../../lib/chartTheme.ts";
import {
  formatTimeRangeLabel,
  formatTimeRangeShortLabel,
  type TimeRangeDays,
} from "../../lib/timeRange.ts";
import { useTrainingDays } from "../../lib/trainingDaysContext.ts";
import { TRAINING_SLOW_QUERY_OPTIONS } from "../../lib/trainingQueryOptions.ts";
import { trpc } from "../../lib/trpc.ts";

export const Route = createFileRoute("/training/cycling")({
  component: CyclingTab,
});

/** Key durations to show in the summary table (seconds). */
const KEY_DURATIONS = [5, 60, 300, 1200] as const;
const DURATION_LABELS: Record<number, string> = {
  5: "5s",
  60: "60s",
  300: "5m",
  1200: "20m",
};

function formatTte(seconds: number | null): string {
  if (seconds == null) return "--";
  const mins = Math.round(seconds / 60);
  return `${mins}m`;
}

const VARIABILITY_PAGE_SIZE = 20;
const ACTIVITY_PAGE_SIZE = 20;

function CyclingTab() {
  const { days } = useTrainingDays();
  return <CyclingContent key={days ?? "all"} days={days} />;
}

function CyclingContent({ days }: { days: TimeRangeDays }) {
  const [variabilityOffset, setVariabilityOffset] = useState(0);
  const [activityPage, setActivityPage] = useState(0);
  const trpcUtils = trpc.useUtils();
  const performance = trpc.cycling.performance.useQuery({ days }, TRAINING_SLOW_QUERY_OPTIONS);
  const activityAnalytics = trpc.cycling.activities.useQuery(
    {
      days,
      activityLimit: ACTIVITY_PAGE_SIZE,
      activityOffset: activityPage * ACTIVITY_PAGE_SIZE,
      variabilityLimit: VARIABILITY_PAGE_SIZE,
      variabilityOffset,
    },
    TRAINING_SLOW_QUERY_OPTIONS,
  );
  const bulkDelete = trpc.activity.bulkDelete.useMutation({
    onSuccess: async () => {
      await Promise.all([
        trpcUtils.cycling.activities.invalidate(),
        trpcUtils.cycling.performance.invalidate(),
        trpcUtils.calendar.weekList.invalidate(),
        trpcUtils.calendar.activityOverview.invalidate(),
      ]);
    },
  });

  // Build lookup: duration → best power for each period
  const recentByDuration = new Map(
    (performance.data?.powerSummary.recent.efforts ?? []).map((effort) => [
      effort.durationSeconds,
      effort,
    ]),
  );
  const seasonByDuration = new Map(
    (performance.data?.powerSummary.season.efforts ?? []).map((effort) => [
      effort.durationSeconds,
      effort,
    ]),
  );

  const recentModel = performance.data?.powerCurve.recent.model ?? null;
  const seasonModel = performance.data?.powerCurve.season.model ?? null;
  const recentSummary = performance.data?.powerSummary.recent;
  const seasonSummary = performance.data?.powerSummary.season;
  const loading = performance.isLoading;

  return (
    <>
      {/* Power Duration Curve with comparison */}
      <Section title="Power Duration Curve" subtitle="Best power at each duration">
        {performance.error ? (
          <QueryStatePanel error={performance.error} />
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-[1fr_auto] gap-6">
            <PowerCurveChart
              data={performance.data?.powerCurve.recent.points ?? []}
              comparisonData={performance.data?.powerCurve.season.points ?? []}
              model={recentModel}
              availability={performance.data?.availability?.powerCurve}
              loading={loading}
            />
            <PowerSummaryTable
              recentByDuration={recentByDuration}
              seasonByDuration={seasonByDuration}
              recentModel={recentModel}
              seasonModel={seasonModel}
              recentMap={recentSummary?.maximalAerobicPower ?? null}
              seasonMap={seasonSummary?.maximalAerobicPower ?? null}
              recentVo2max={recentSummary?.vo2Max ?? null}
              seasonVo2max={seasonSummary?.vo2Max ?? null}
              recentTte={recentSummary?.timeToExhaustionSeconds ?? null}
              seasonTte={seasonSummary?.timeToExhaustionSeconds ?? null}
              loading={loading}
              recentDays={days}
            />
          </div>
        )}
        {/* Period labels */}
        <div className="mt-3 flex flex-wrap gap-4 text-xs">
          <PeriodLabel
            color={chartColors.purple}
            label={formatTimeRangeLabel(days)}
            model={recentModel}
          />
          <PeriodLabel color={chartThemeColors.axisLabel} label="This season" model={seasonModel} />
        </div>
      </Section>

      {/* Fitness / Fatigue / Form */}
      <Section
        title="Fitness, Fatigue & Form"
        subtitle="42-day fitness (blue), 7-day fatigue (purple), form = fitness − fatigue"
      >
        {performance.error ? (
          <QueryStatePanel error={performance.error} />
        ) : (
          <PmcChart
            data={performance.data?.pmc.data ?? []}
            model={performance.data?.pmc.model}
            availability={performance.data?.availability?.pmc}
            loading={performance.isLoading}
          />
        )}
      </Section>

      {/* eFTP Trend */}
      <Section
        title="Estimated Threshold Power Trend"
        subtitle="Per-activity normalized power × 0.95"
      >
        {performance.error ? (
          <QueryStatePanel error={performance.error} />
        ) : (
          <EftpTrendChart
            data={performance.data?.eftpTrend.trend ?? []}
            currentEftp={performance.data?.eftpTrend.currentEftp ?? null}
            availability={performance.data?.availability?.eftpTrend}
            loading={performance.isLoading}
          />
        )}
      </Section>

      {/* Aerobic Efficiency + Activity Variability */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Section
          title="Aerobic Efficiency"
          subtitle="Power output per heartbeat at easy effort — higher means fitter"
        >
          {activityAnalytics.error ? (
            <QueryStatePanel error={activityAnalytics.error} />
          ) : (
            <AerobicEfficiencyChart
              activities={activityAnalytics.data?.aerobicEfficiency.activities ?? []}
              maxHr={activityAnalytics.data?.aerobicEfficiency.maxHr ?? null}
              availability={activityAnalytics.data?.availability?.aerobicEfficiency}
              loading={activityAnalytics.isLoading}
            />
          )}
        </Section>

        <Section
          title="Vertical Ascent Rate"
          subtitle="Climbing speed — meters gained per hour while ascending"
        >
          {activityAnalytics.error ? (
            <QueryStatePanel error={activityAnalytics.error} />
          ) : (
            <VerticalAscentChart
              data={activityAnalytics.data?.verticalAscent ?? []}
              availability={activityAnalytics.data?.availability?.verticalAscent}
              loading={activityAnalytics.isLoading}
            />
          )}
        </Section>
      </div>

      <Section
        title="Activity Variability Index"
        subtitle="Normalized power vs average power ratio per activity"
      >
        {activityAnalytics.error ? (
          <QueryStatePanel error={activityAnalytics.error} />
        ) : (
          <ActivityVariabilityTable
            data={activityAnalytics.data?.variability.rows ?? []}
            totalCount={activityAnalytics.data?.variability.totalCount ?? 0}
            offset={variabilityOffset}
            limit={VARIABILITY_PAGE_SIZE}
            onPageChange={setVariabilityOffset}
            loading={activityAnalytics.isLoading}
            emptyReason={activityAnalytics.data?.variability.emptyReason ?? undefined}
          />
        )}
      </Section>

      <Section title="Recent Cycling Activities" subtitle="Recent rides and cycling workouts">
        <ActivityList
          activities={activityAnalytics.data?.activities.items ?? []}
          loading={activityAnalytics.isLoading}
          error={activityAnalytics.error?.message}
          totalCount={activityAnalytics.data?.activities.totalCount}
          page={activityPage}
          pageSize={ACTIVITY_PAGE_SIZE}
          onPageChange={setActivityPage}
          onBulkDelete={(ids) => bulkDelete.mutate({ ids })}
          bulkDeletePending={bulkDelete.isPending}
          bulkDeleteError={bulkDelete.error?.message}
        />
      </Section>
    </>
  );
}

// ── Power Summary Table ──

interface PowerSummaryTableProps {
  recentByDuration: Map<number, { watts: number; wattsPerKg: number | null }>;
  seasonByDuration: Map<number, { watts: number; wattsPerKg: number | null }>;
  recentModel: { cp: number; wPrime: number; r2: number } | null;
  seasonModel: { cp: number; wPrime: number; r2: number } | null;
  recentMap: number | null;
  seasonMap: number | null;
  recentVo2max: number | null;
  seasonVo2max: number | null;
  recentTte: number | null;
  seasonTte: number | null;
  loading: boolean;
  recentDays: TimeRangeDays;
}

function PowerSummaryTable({
  recentByDuration,
  seasonByDuration,
  recentModel,
  seasonModel,
  recentMap,
  seasonMap,
  recentVo2max,
  seasonVo2max,
  recentTte,
  seasonTte,
  loading,
  recentDays,
}: PowerSummaryTableProps) {
  if (loading) {
    return <div className="w-[260px] animate-pulse bg-skeleton rounded h-[280px]" />;
  }

  return (
    <div className="min-w-[260px]">
      <table className="w-full text-xs text-foreground font-mono">
        <thead>
          <tr className="border-b border-border-strong text-subtle">
            <th className="text-left py-1 pr-3">Time</th>
            <th className="text-right px-2" colSpan={2}>
              <span className="text-violet-400">{formatTimeRangeShortLabel(recentDays)}</span>
            </th>
            <th className="text-right pl-2" colSpan={2}>
              <span className="text-muted">Season</span>
            </th>
          </tr>
          <tr className="border-b border-border text-dim">
            <th />
            <th className="text-right px-2 font-normal">w</th>
            <th className="text-right px-2 font-normal">w/kg</th>
            <th className="text-right px-2 font-normal">w</th>
            <th className="text-right px-2 font-normal">w/kg</th>
          </tr>
        </thead>
        <tbody>
          {KEY_DURATIONS.map((dur) => {
            const recent = recentByDuration.get(dur);
            const season = seasonByDuration.get(dur);
            return (
              <tr key={dur} className="border-b border-border/50">
                <td className="py-1.5 pr-3 text-muted">{DURATION_LABELS[dur]}</td>
                <td className="text-right px-2 text-violet-300">{recent?.watts ?? "--"}</td>
                <td className="text-right px-2 text-violet-300">
                  {recent?.wattsPerKg == null ? "--" : formatNumber(recent.wattsPerKg, 2)}
                </td>
                <td className="text-right px-2">{season?.watts ?? "--"}</td>
                <td className="text-right px-2">
                  {season?.wattsPerKg == null ? "--" : formatNumber(season.wattsPerKg, 2)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {/* Derived metrics */}
      <div className="mt-3 space-y-1 text-xs">
        <DerivedRow label="Maximal Aerobic Power" recent={recentMap} season={seasonMap} unit="W" />
        <DerivedRow
          label="Time to Exhaustion"
          recentStr={formatTte(recentTte)}
          seasonStr={formatTte(seasonTte)}
        />
        <DerivedRow label="VO2max (est.)" recent={recentVo2max} season={seasonVo2max} unit="" />
        <DerivedRow
          label="Critical Power"
          recent={recentModel?.cp ?? null}
          season={seasonModel?.cp ?? null}
          unit="W"
        />
        <DerivedRow
          label="Anaerobic Reserve (W')"
          recentStr={recentModel ? `${Math.round(recentModel.wPrime / 1000)}kJ` : "--"}
          seasonStr={seasonModel ? `${Math.round(seasonModel.wPrime / 1000)}kJ` : "--"}
        />
      </div>
    </div>
  );
}

function DerivedRow({
  label,
  recent,
  season,
  unit,
  recentStr,
  seasonStr,
}: {
  label: string;
  recent?: number | null;
  season?: number | null;
  unit?: string;
  recentStr?: string;
  seasonStr?: string;
}) {
  const recentDisplay = recentStr ?? (recent != null ? `${recent}${unit}` : "--");
  const seasonDisplay = seasonStr ?? (season != null ? `${season}${unit}` : "--");
  return (
    <div className="flex justify-between text-muted">
      <span>{label}</span>
      <span>
        <span className="text-violet-300">{recentDisplay}</span>
        <span className="mx-1 text-dim">/</span>
        <span>{seasonDisplay}</span>
      </span>
    </div>
  );
}

function PeriodLabel({
  color,
  label,
  model,
}: {
  color: string;
  label: string;
  model: { cp: number; wPrime: number; r2: number } | null;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 text-subtle">
      <span className="w-3 h-0.5 rounded-full inline-block" style={{ backgroundColor: color }} />
      <span style={{ color }}>{label}</span>
      {model && (
        <span className="text-dim">
          Estimated Threshold Power {model.cp}w · Anaerobic Reserve (W'){" "}
          {Math.round(model.wPrime / 1000)}kJ
        </span>
      )}
    </span>
  );
}

// ── Section helper ──

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  const description = subtitle ?? `${title} chart.`;

  return (
    <section>
      <div className="mb-1 flex items-center gap-2">
        <h2 className="text-sm font-medium text-muted uppercase tracking-wider">{title}</h2>
        <ChartDescriptionTooltip description={description} />
      </div>
      {subtitle && <p className="text-xs text-dim mb-4">{subtitle}</p>}
      <div className="card p-4" title={description}>
        {children}
      </div>
    </section>
  );
}
