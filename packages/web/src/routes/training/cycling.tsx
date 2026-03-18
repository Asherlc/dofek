import { createFileRoute } from "@tanstack/react-router";
import { ActivityVariabilityTable } from "../../components/ActivityVariabilityTable.tsx";
import { AerobicEfficiencyChart } from "../../components/AerobicEfficiencyChart.tsx";
import { EftpTrendChart } from "../../components/EftpTrendChart.tsx";
import { PowerCurveChart } from "../../components/PowerCurveChart.tsx";
import { VerticalAscentChart } from "../../components/VerticalAscentChart.tsx";
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

function CyclingTab() {
  const { days } = useTrainingDays();

  // Recent period = user-selected range
  const recentCurve = trpc.power.powerCurve.useQuery({ days });
  const seasonCurve = trpc.power.powerCurve.useQuery({ days: 365 });
  const eftpTrend = trpc.power.eftpTrend.useQuery({ days: 365 });
  const efficiency = trpc.efficiency.aerobicEfficiency.useQuery({ days });
  const variability = trpc.cyclingAdvanced.activityVariability.useQuery({ days });
  const verticalAscent = trpc.cyclingAdvanced.verticalAscentRate.useQuery({ days });
  const bodyData = trpc.body.list.useQuery({ days: 365 });

  // Extract latest weight for w/kg calculations
  const latestWeight = bodyData.data?.[0]?.weight_kg as number | undefined;

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
          <PeriodLabel color="#8b5cf6" label={`${days} days`} model={recentModel} />
          <PeriodLabel color="#71717a" label="This season" model={seasonModel} />
        </div>
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
        <ActivityVariabilityTable data={variability.data ?? []} loading={variability.isLoading} />
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
    return <div className="w-[260px] animate-pulse bg-zinc-800 rounded h-[280px]" />;
  }

  function wkg(watts: number | null): string {
    if (watts == null || !weightKg) return "--";
    return (watts / weightKg).toFixed(2);
  }

  return (
    <div className="min-w-[260px]">
      <table className="w-full text-xs text-zinc-300 font-mono">
        <thead>
          <tr className="border-b border-zinc-700 text-zinc-500">
            <th className="text-left py-1 pr-3">Time</th>
            <th className="text-right px-2" colSpan={2}>
              <span className="text-violet-400">{recentDays}d</span>
            </th>
            <th className="text-right pl-2" colSpan={2}>
              <span className="text-zinc-400">Season</span>
            </th>
          </tr>
          <tr className="border-b border-zinc-800 text-zinc-600">
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
              <tr key={dur} className="border-b border-zinc-800/50">
                <td className="py-1.5 pr-3 text-zinc-400">{DURATION_LABELS[dur]}</td>
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
  const r = recentStr ?? (recent != null ? `${recent}${unit}` : "--");
  const s = seasonStr ?? (season != null ? `${season}${unit}` : "--");
  return (
    <div className="flex justify-between text-zinc-400">
      <span>{label}</span>
      <span>
        <span className="text-violet-300">{r}</span>
        <span className="mx-1 text-zinc-700">/</span>
        <span>{s}</span>
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
    <span className="inline-flex items-center gap-1.5 text-zinc-500">
      <span className="w-3 h-0.5 rounded-full inline-block" style={{ backgroundColor: color }} />
      <span style={{ color }}>{label}</span>
      {model && (
        <span className="text-zinc-600">
          eFTP {model.cp}w · W' {Math.round(model.wPrime)}J
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
  return (
    <section>
      <h2 className="text-sm font-medium text-zinc-400 uppercase tracking-wider mb-1">{title}</h2>
      {subtitle && <p className="text-xs text-zinc-600 mb-4">{subtitle}</p>}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">{children}</div>
    </section>
  );
}
