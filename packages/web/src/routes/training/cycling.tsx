import { formatNumber } from "@dofek/format/format";
import { CYCLING_ACTIVITY_TYPES } from "@dofek/training/training";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { ActivityVariabilityTable } from "../../components/ActivityVariabilityTable.tsx";
import { AerobicEfficiencyChart } from "../../components/AerobicEfficiencyChart.tsx";
import { ChartDescriptionTooltip } from "../../components/ChartDescriptionTooltip.tsx";
import { EftpTrendChart } from "../../components/EftpTrendChart.tsx";
import { PmcChart } from "../../components/PmcChart.tsx";
import { PowerCurveChart } from "../../components/PowerCurveChart.tsx";
import { RecentActivitiesSection } from "../../components/RecentActivitiesSection.tsx";
import { VerticalAscentChart } from "../../components/VerticalAscentChart.tsx";
import { chartColors, chartThemeColors } from "../../lib/chartTheme.ts";
import { useTrainingDays } from "../../lib/trainingDaysContext.ts";
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

/** Estimate VO2max from 5-minute best power and body weight.
 *  Formula: (MAP_watts / weight_kg × 10.8) + 7  (Hawley & Noakes) */
function estimateVo2max(mapWatts: number, weightKg: number): number {
  return (mapWatts / weightKg) * 10.8 + 7;
}

/** Time to Exhaustion at CP: how long W' lasts above CP.
 *  TTE = W' / (MAP - CP), returns seconds. */
function estimateTte(wPrime: number, mapWatts: number, cp: number): number | null {
  const diff = mapWatts - cp;
  if (diff <= 0) return null;
  return wPrime / diff;
}

function formatTte(seconds: number | null): string {
  if (seconds == null) return "--";
  const mins = Math.round(seconds / 60);
  return `${mins}m`;
}

const VARIABILITY_PAGE_SIZE = 20;

function CyclingTab() {
  const { days } = useTrainingDays();
  const [variabilityOffset, setVariabilityOffset] = useState(0);

  // Recent period = user-selected range
  const recentCurve = trpc.power.powerCurve.useQuery({ days });
  const seasonCurve = trpc.power.powerCurve.useQuery({ days: 365 });
  const eftpTrend = trpc.power.eftpTrend.useQuery({ days: 365 });
  const pmc = trpc.pmc.chart.useQuery({ days });
  const efficiency = trpc.efficiency.aerobicEfficiency.useQuery({ days });
  const variability = trpc.cyclingAdvanced.activityVariability.useQuery({
    days,
    limit: VARIABILITY_PAGE_SIZE,
    offset: variabilityOffset,
  });
  const verticalAscent = trpc.cyclingAdvanced.verticalAscentRate.useQuery({ days });
  const bodyData = trpc.body.list.useQuery({ days: 365 });

  // Extract latest weight for w/kg calculations
  const rawWeight = bodyData.data?.[0]?.weightKg;
  const latestWeight = typeof rawWeight === "number" ? rawWeight : undefined;

  // Build lookup: duration → best power for each period
  const recentByDuration = new Map(
    (recentCurve.data?.points ?? []).map((p) => [p.durationSeconds, p.bestPower]),
  );
  const seasonByDuration = new Map(
    (seasonCurve.data?.points ?? []).map((p) => [p.durationSeconds, p.bestPower]),
  );

  const recentModel = recentCurve.data?.model ?? null;
  const seasonModel = seasonCurve.data?.model ?? null;

  // Derived metrics
  const recentMap = recentByDuration.get(300) ?? null; // 5m best = MAP proxy
  const seasonMap = seasonByDuration.get(300) ?? null;

  const recentVo2max =
    recentMap && latestWeight
      ? Math.round(estimateVo2max(recentMap, latestWeight) * 10) / 10
      : null;
  const seasonVo2max =
    seasonMap && latestWeight
      ? Math.round(estimateVo2max(seasonMap, latestWeight) * 10) / 10
      : null;

  const recentTte =
    recentModel && recentMap ? estimateTte(recentModel.wPrime, recentMap, recentModel.cp) : null;
  const seasonTte =
    seasonModel && seasonMap ? estimateTte(seasonModel.wPrime, seasonMap, seasonModel.cp) : null;

  const loading = recentCurve.isLoading || seasonCurve.isLoading;

  return (
    <>
      {/* Power Duration Curve with comparison */}
      <Section title="Power Duration Curve" subtitle="Best power at each duration">
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_auto] gap-6">
          <PowerCurveChart
            data={recentCurve.data?.points ?? []}
            comparisonData={seasonCurve.data?.points ?? []}
            model={recentModel}
            loading={loading}
          />
          <PowerSummaryTable
            recentByDuration={recentByDuration}
            seasonByDuration={seasonByDuration}
            recentModel={recentModel}
            seasonModel={seasonModel}
            recentMap={recentMap}
            seasonMap={seasonMap}
            recentVo2max={recentVo2max}
            seasonVo2max={seasonVo2max}
            recentTte={recentTte}
            seasonTte={seasonTte}
            weightKg={latestWeight ?? null}
            loading={loading}
            recentDays={days}
          />
        </div>
        {/* Period labels */}
        <div className="mt-3 flex flex-wrap gap-4 text-xs">
          <PeriodLabel color={chartColors.purple} label={`${days} days`} model={recentModel} />
          <PeriodLabel color={chartThemeColors.axisLabel} label="This season" model={seasonModel} />
        </div>
      </Section>

      {/* Fitness / Fatigue / Form */}
      <Section
        title="Fitness, Fatigue & Form"
        subtitle="42-day fitness (blue), 7-day fatigue (purple), form = fitness − fatigue"
      >
        <PmcChart data={pmc.data?.data ?? []} model={pmc.data?.model} loading={pmc.isLoading} />
      </Section>

      {/* eFTP Trend */}
      <Section
        title="Estimated Threshold Power Trend"
        subtitle="Per-activity normalized power × 0.95"
      >
        <EftpTrendChart
          data={eftpTrend.data?.trend ?? []}
          currentEftp={eftpTrend.data?.currentEftp ?? null}
          loading={eftpTrend.isLoading}
        />
      </Section>

      {/* Aerobic Efficiency + Activity Variability */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Section
          title="Aerobic Efficiency"
          subtitle="Power output per heartbeat at easy effort — higher means fitter"
        >
          <AerobicEfficiencyChart
            activities={efficiency.data?.activities ?? []}
            maxHr={efficiency.data?.maxHr ?? null}
            loading={efficiency.isLoading}
          />
        </Section>

        <Section title="Vertical Ascent Rate" subtitle="Climbing speed on grade >3% segments">
          <VerticalAscentChart
            data={verticalAscent.data ?? []}
            loading={verticalAscent.isLoading}
          />
        </Section>
      </div>

      <Section
        title="Activity Variability Index"
        subtitle="Normalized power vs average power ratio per activity"
      >
        <ActivityVariabilityTable
          data={variability.data?.rows ?? []}
          totalCount={variability.data?.totalCount ?? 0}
          offset={variabilityOffset}
          limit={VARIABILITY_PAGE_SIZE}
          onPageChange={setVariabilityOffset}
          loading={variability.isLoading}
        />
      </Section>

      <Section title="Recent Cycling Activities" subtitle="Recent rides and cycling workouts">
        <RecentActivitiesSection activityTypes={CYCLING_ACTIVITY_TYPES} />
      </Section>
    </>
  );
}

// ── Power Summary Table ──

interface PowerSummaryTableProps {
  recentByDuration: Map<number, number>;
  seasonByDuration: Map<number, number>;
  recentModel: { cp: number; wPrime: number; r2: number } | null;
  seasonModel: { cp: number; wPrime: number; r2: number } | null;
  recentMap: number | null;
  seasonMap: number | null;
  recentVo2max: number | null;
  seasonVo2max: number | null;
  recentTte: number | null;
  seasonTte: number | null;
  weightKg: number | null;
  loading: boolean;
  recentDays: number;
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
  weightKg,
  loading,
  recentDays,
}: PowerSummaryTableProps) {
  if (loading) {
    return <div className="w-[260px] animate-pulse bg-skeleton rounded h-[280px]" />;
  }

  function wkg(watts: number | null): string {
    if (watts == null || !weightKg) return "--";
    return formatNumber(watts / weightKg, 2);
  }

  return (
    <div className="min-w-[260px]">
      <table className="w-full text-xs text-foreground font-mono">
        <thead>
          <tr className="border-b border-border-strong text-subtle">
            <th className="text-left py-1 pr-3">Time</th>
            <th className="text-right px-2" colSpan={2}>
              <span className="text-violet-400">{recentDays}d</span>
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
            const recent = recentByDuration.get(dur) ?? null;
            const season = seasonByDuration.get(dur) ?? null;
            return (
              <tr key={dur} className="border-b border-border/50">
                <td className="py-1.5 pr-3 text-muted">{DURATION_LABELS[dur]}</td>
                <td className="text-right px-2 text-violet-300">{recent ?? "--"}</td>
                <td className="text-right px-2 text-violet-300">{wkg(recent)}</td>
                <td className="text-right px-2">{season ?? "--"}</td>
                <td className="text-right px-2">{wkg(season)}</td>
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
