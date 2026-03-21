import { createFileRoute } from "@tanstack/react-router";
import { ChartDescriptionTooltip } from "../../components/ChartDescriptionTooltip.tsx";
import { DofekChart } from "../../components/DofekChart.tsx";
import { ChartLoadingSkeleton } from "../../components/LoadingSkeleton.tsx";
import {
  chartColors,
  dofekAxis,
  dofekGrid,
  dofekLegend,
  dofekSeries,
  dofekTooltip,
} from "../../lib/chartTheme.ts";
import { useTrainingDays } from "../../lib/trainingDaysContext.ts";
import { trpc } from "../../lib/trpc.ts";
import { useUnitSystem } from "../../lib/unitContext.ts";
import type { UnitSystem } from "../../lib/units.ts";
import { convertDistance, convertPace, distanceLabel, paceLabel } from "../../lib/units.ts";

export const Route = createFileRoute("/training/running")({
  component: RunningTab,
});

import { formatNumber, formatPace } from "../../lib/format.ts";

export function RunningTab() {
  const { days } = useTrainingDays();
  const { unitSystem } = useUnitSystem();

  const paceCurve = trpc.durationCurves.paceCurve.useQuery({ days });
  const paceTrend = trpc.running.paceTrend.useQuery({ days });
  const dynamics = trpc.running.dynamics.useQuery({ days });

  return (
    <>
      {/* Pace Duration Curve */}
      <Section title="Pace Duration Curve" subtitle="Best sustained pace at each duration">
        <PaceCurveChart
          data={paceCurve.data?.points ?? []}
          loading={paceCurve.isLoading}
          unitSystem={unitSystem}
        />
      </Section>

      {/* Pace Trend + Running Dynamics side by side */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Section title="Pace Trend" subtitle="Average pace per run over time">
          <PaceTrendChart
            data={paceTrend.data ?? []}
            loading={paceTrend.isLoading}
            unitSystem={unitSystem}
          />
        </Section>

        <Section title="Cadence Trend" subtitle="Steps per minute over time">
          <CadenceTrendChart data={dynamics.data ?? []} loading={dynamics.isLoading} />
        </Section>
      </div>

      {/* Running Dynamics Table */}
      <Section title="Running Form" subtitle="Per-activity running dynamics">
        <RunningDynamicsTable
          data={dynamics.data ?? []}
          loading={dynamics.isLoading}
          unitSystem={unitSystem}
        />
      </Section>
    </>
  );
}

// ── Pace Duration Curve Chart ──

interface PaceCurvePoint {
  durationSeconds: number;
  label: string;
  bestPaceSecondsPerKm: number;
  activityDate: string;
}

function PaceCurveChart({
  data,
  loading,
  unitSystem,
}: {
  data: PaceCurvePoint[];
  loading: boolean;
  unitSystem: UnitSystem;
}) {
  const option = {
    grid: { ...dofekGrid("single"), top: 30, bottom: 40, left: 65 },
    tooltip: dofekTooltip({
      trigger: "item",
      formatter: (params: { data: [number, number]; seriesName: string }) => {
        const [seconds, pace] = params.data;
        const durLabel =
          seconds < 60
            ? `${seconds}s`
            : seconds < 3600
              ? `${Math.round(seconds / 60)}min`
              : `${Math.round(seconds / 3600)}h`;
        return `${durLabel}: <strong>${formatPace(pace)} ${paceLabel(unitSystem)}</strong>`;
      },
    }),
    xAxis: {
      ...dofekAxis.value({
        type: "log",
        min: 5,
        max: 7200,
        axisLabel: {
          formatter: (value: number) =>
            value < 60
              ? `${value}s`
              : value < 3600
                ? `${Math.round(value / 60)}m`
                : `${Math.round(value / 3600)}h`,
        },
      }),
      name: "Duration",
      nameLocation: "center" as const,
      nameGap: 25,
      splitLine: { show: false },
    },
    yAxis: {
      ...dofekAxis.value({
        name: `Pace (min${paceLabel(unitSystem)})`,
        axisLabel: {
          formatter: (value: number) => formatPace(value),
        },
      }),
      inverse: true, // faster pace (lower number) at top
    },
    legend: dofekLegend(false),
    series: [
      dofekSeries.line(
        "Best Pace",
        data.map((d) => [d.durationSeconds, convertPace(d.bestPaceSecondsPerKm, unitSystem)]),
        {
          color: chartColors.emerald,
          smooth: 0.3,
          symbol: "circle",
          symbolSize: 6,
          width: 3,
          areaStyle: { opacity: 0.1, color: chartColors.emerald },
        },
      ),
    ],
  };

  return (
    <DofekChart
      option={option}
      loading={loading}
      empty={data.length === 0}
      height={280}
      emptyMessage="No running pace data"
    />
  );
}

// ── Pace Trend Chart ──

interface PaceTrendPoint {
  date: string;
  activityName: string;
  paceSecondsPerKm: number;
  distanceKm: number;
  durationMinutes: number;
}

function PaceTrendChart({
  data,
  loading,
  unitSystem,
}: {
  data: PaceTrendPoint[];
  loading: boolean;
  unitSystem: UnitSystem;
}) {
  const option = {
    grid: { ...dofekGrid("single"), top: 20, bottom: 40, left: 65 },
    tooltip: dofekTooltip({
      trigger: "item",
      formatter: (params: { data: [string, number]; dataIndex: number }) => {
        const dataPoint = data[params.dataIndex];
        if (!dataPoint) return "";
        return [
          `<strong>${dataPoint.activityName}</strong>`,
          `${dataPoint.date}`,
          `Pace: ${formatPace(convertPace(dataPoint.paceSecondsPerKm, unitSystem))} ${paceLabel(unitSystem)}`,
          `Distance: ${formatNumber(convertDistance(dataPoint.distanceKm, unitSystem))} ${distanceLabel(unitSystem)} · ${dataPoint.durationMinutes} min`,
        ].join("<br/>");
      },
    }),
    xAxis: dofekAxis.time(),
    yAxis: {
      ...dofekAxis.value({
        axisLabel: {
          formatter: (value: number) => formatPace(value),
        },
      }),
      inverse: true, // faster pace (lower number) at top
    },
    legend: dofekLegend(false),
    series: [
      {
        type: "scatter" as const,
        data: data.map((d) => [d.date, convertPace(d.paceSecondsPerKm, unitSystem)]),
        symbolSize: (val: [string, number]) => {
          const matchedActivity = data.find(
            (p) => convertPace(p.paceSecondsPerKm, unitSystem) === val[1],
          );
          return Math.min(Math.max((matchedActivity?.distanceKm ?? 5) * 1.5, 4), 16);
        },
        itemStyle: { color: chartColors.emerald, opacity: 0.7 },
      },
    ],
  };

  return (
    <DofekChart
      option={option}
      loading={loading}
      empty={data.length === 0}
      height={250}
      emptyMessage="No running data"
    />
  );
}

// ── Cadence Trend Chart ──

interface DynamicsRow {
  date: string;
  activityName: string;
  cadence: number;
  strideLengthMeters: number | null;
  stanceTimeMs: number | null;
  verticalOscillationMm: number | null;
  paceSecondsPerKm: number;
  distanceKm: number;
}

function CadenceTrendChart({ data, loading }: { data: DynamicsRow[]; loading: boolean }) {
  const option = {
    grid: { ...dofekGrid("single"), top: 20, bottom: 40, left: 55 },
    tooltip: dofekTooltip({
      trigger: "item",
      formatter: (params: { data: [string, number]; dataIndex: number }) => {
        const dataPoint = data[params.dataIndex];
        if (!dataPoint) return "";
        return `<strong>${dataPoint.activityName}</strong><br/>${dataPoint.date}<br/>Cadence: ${dataPoint.cadence} spm`;
      },
    }),
    xAxis: dofekAxis.time(),
    yAxis: dofekAxis.value({ name: "Steps/min" }),
    legend: dofekLegend(false),
    series: [
      dofekSeries.line(
        "Cadence",
        data.map((d) => [d.date, d.cadence]),
        {
          color: chartColors.amber,
          smooth: true,
          symbol: "circle",
          symbolSize: 5,
        },
      ),
    ],
  };

  return (
    <DofekChart
      option={option}
      loading={loading}
      empty={data.length === 0}
      height={250}
      emptyMessage="No cadence data"
    />
  );
}

// ── Running Dynamics Table ──

function RunningDynamicsTable({
  data,
  loading,
  unitSystem,
}: {
  data: DynamicsRow[];
  loading: boolean;
  unitSystem: UnitSystem;
}) {
  if (loading) return <ChartLoadingSkeleton height={200} />;

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-[100px]">
        <span className="text-dim text-sm">No running dynamics data</span>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-border-strong text-subtle text-left">
            <th className="py-2 pr-3">Date</th>
            <th className="py-2 pr-3">Activity</th>
            <th className="py-2 pr-3 text-right">Pace</th>
            <th className="py-2 pr-3 text-right">Distance</th>
            <th className="py-2 pr-3 text-right">Cadence</th>
            <th className="py-2 pr-3 text-right">Stride</th>
            <th className="py-2 pr-3 text-right">Stance Time</th>
            <th className="py-2 text-right">Vert. Osc.</th>
          </tr>
        </thead>
        <tbody>
          {data
            .slice()
            .reverse()
            .map((d) => (
              <tr
                key={`${d.date}-${d.activityName}`}
                className="border-b border-border/50 text-foreground"
              >
                <td className="py-1.5 pr-3 text-subtle">{d.date}</td>
                <td className="py-1.5 pr-3 truncate max-w-[150px]">{d.activityName}</td>
                <td className="py-1.5 pr-3 text-right font-mono">
                  {formatPace(convertPace(d.paceSecondsPerKm, unitSystem))} {paceLabel(unitSystem)}
                </td>
                <td className="py-1.5 pr-3 text-right font-mono">
                  {formatNumber(convertDistance(d.distanceKm, unitSystem))}{" "}
                  {distanceLabel(unitSystem)}
                </td>
                <td className="py-1.5 pr-3 text-right font-mono">{d.cadence}</td>
                <td className="py-1.5 pr-3 text-right font-mono">
                  {d.strideLengthMeters != null
                    ? `${formatNumber(d.strideLengthMeters, 2)} m`
                    : "--"}
                </td>
                <td className="py-1.5 pr-3 text-right font-mono">
                  {d.stanceTimeMs != null ? `${Math.round(d.stanceTimeMs)} ms` : "--"}
                </td>
                <td className="py-1.5 text-right font-mono">
                  {d.verticalOscillationMm != null
                    ? `${formatNumber(d.verticalOscillationMm)} mm`
                    : "--"}
                </td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
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
