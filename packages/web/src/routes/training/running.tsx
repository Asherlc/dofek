import { createFileRoute } from "@tanstack/react-router";
import ReactECharts from "echarts-for-react";
import { ChartDescriptionTooltip } from "../../components/ChartDescriptionTooltip.tsx";
import { ChartLoadingSkeleton } from "../../components/LoadingSkeleton.tsx";
import { useTrainingDays } from "../../lib/trainingDaysContext.ts";
import { trpc } from "../../lib/trpc.ts";

export const Route = createFileRoute("/training/running")({
  component: RunningTab,
});

import { formatPace } from "@dofek/format/format";

function RunningTab() {
  const { days } = useTrainingDays();

  const paceCurve = trpc.durationCurves.paceCurve.useQuery({ days });
  const paceTrend = trpc.running.paceTrend.useQuery({ days });
  const dynamics = trpc.running.dynamics.useQuery({ days });

  return (
    <>
      {/* Pace Duration Curve */}
      <Section title="Pace Duration Curve" subtitle="Best sustained pace at each duration">
        <PaceCurveChart data={paceCurve.data?.points ?? []} loading={paceCurve.isLoading} />
      </Section>

      {/* Pace Trend + Running Dynamics side by side */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Section title="Pace Trend" subtitle="Average pace per run over time">
          <PaceTrendChart data={paceTrend.data ?? []} loading={paceTrend.isLoading} />
        </Section>

        <Section title="Cadence Trend" subtitle="Steps per minute over time">
          <CadenceTrendChart data={dynamics.data ?? []} loading={dynamics.isLoading} />
        </Section>
      </div>

      {/* Running Dynamics Table */}
      <Section title="Running Form" subtitle="Per-activity running dynamics">
        <RunningDynamicsTable data={dynamics.data ?? []} loading={dynamics.isLoading} />
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

function PaceCurveChart({ data, loading }: { data: PaceCurvePoint[]; loading: boolean }) {
  if (loading) return <ChartLoadingSkeleton height={280} />;

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-[280px]">
        <span className="text-zinc-600 text-sm">No running pace data</span>
      </div>
    );
  }

  const option = {
    backgroundColor: "transparent",
    grid: { top: 30, right: 20, bottom: 40, left: 65 },
    tooltip: {
      trigger: "item" as const,
      backgroundColor: "#18181b",
      borderColor: "#3f3f46",
      textStyle: { color: "#e4e4e7", fontSize: 12 },
      formatter: (params: { data: [number, number]; seriesName: string }) => {
        const [seconds, pace] = params.data;
        const durLabel =
          seconds < 60
            ? `${seconds}s`
            : seconds < 3600
              ? `${Math.round(seconds / 60)}min`
              : `${Math.round(seconds / 3600)}h`;
        return `${durLabel}: <strong>${formatPace(pace)} /km</strong>`;
      },
    },
    xAxis: {
      type: "log" as const,
      name: "Duration",
      nameLocation: "center" as const,
      nameGap: 25,
      nameTextStyle: { color: "#71717a", fontSize: 11 },
      min: 5,
      max: 7200,
      axisLabel: {
        color: "#71717a",
        fontSize: 11,
        formatter: (value: number) =>
          value < 60
            ? `${value}s`
            : value < 3600
              ? `${Math.round(value / 60)}m`
              : `${Math.round(value / 3600)}h`,
      },
      axisLine: { lineStyle: { color: "#3f3f46" } },
      splitLine: { show: false },
    },
    yAxis: {
      type: "value" as const,
      name: "Pace (min/km)",
      inverse: true, // faster pace (lower number) at top
      splitLine: { lineStyle: { color: "#27272a" } },
      axisLabel: {
        color: "#71717a",
        fontSize: 11,
        formatter: (value: number) => formatPace(value),
      },
      axisLine: { show: true, lineStyle: { color: "#3f3f46" } },
      nameTextStyle: { color: "#71717a", fontSize: 11 },
    },
    series: [
      {
        name: "Best Pace",
        type: "line",
        data: data.map((d) => [d.durationSeconds, d.bestPaceSecondsPerKm]),
        smooth: 0.3,
        symbol: "circle",
        symbolSize: 6,
        lineStyle: { width: 3, color: "#10b981" },
        itemStyle: { color: "#10b981" },
        areaStyle: { opacity: 0.1, color: "#10b981" },
      },
    ],
  };

  return <ReactECharts option={option} style={{ height: 280 }} notMerge={true} />;
}

// ── Pace Trend Chart ──

interface PaceTrendPoint {
  date: string;
  activityName: string;
  paceSecondsPerKm: number;
  distanceKm: number;
  durationMinutes: number;
}

function PaceTrendChart({ data, loading }: { data: PaceTrendPoint[]; loading: boolean }) {
  if (loading) return <ChartLoadingSkeleton height={250} />;

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-[250px]">
        <span className="text-zinc-600 text-sm">No running data</span>
      </div>
    );
  }

  const option = {
    backgroundColor: "transparent",
    grid: { top: 20, right: 20, bottom: 40, left: 65 },
    tooltip: {
      trigger: "item" as const,
      backgroundColor: "#18181b",
      borderColor: "#3f3f46",
      textStyle: { color: "#e4e4e7", fontSize: 12 },
      formatter: (params: { data: [string, number]; dataIndex: number }) => {
        const d = data[params.dataIndex];
        if (!d) return "";
        return [
          `<strong>${d.activityName}</strong>`,
          `${d.date}`,
          `Pace: ${formatPace(d.paceSecondsPerKm)} /km`,
          `Distance: ${d.distanceKm} km · ${d.durationMinutes} min`,
        ].join("<br/>");
      },
    },
    xAxis: {
      type: "time" as const,
      axisLabel: { color: "#71717a", fontSize: 11 },
      axisLine: { lineStyle: { color: "#3f3f46" } },
    },
    yAxis: {
      type: "value" as const,
      inverse: true,
      axisLabel: {
        color: "#71717a",
        fontSize: 11,
        formatter: (value: number) => formatPace(value),
      },
      splitLine: { lineStyle: { color: "#27272a" } },
      axisLine: { show: false },
    },
    series: [
      {
        type: "scatter",
        data: data.map((d) => [d.date, d.paceSecondsPerKm]),
        symbolSize: (val: [string, number]) => {
          const d = data.find((p) => p.date === val[0] && p.paceSecondsPerKm === val[1]);
          return Math.min(Math.max((d?.distanceKm ?? 5) * 1.5, 4), 16);
        },
        itemStyle: { color: "#10b981", opacity: 0.7 },
      },
    ],
  };

  return <ReactECharts option={option} style={{ height: 250 }} notMerge={true} />;
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
  if (loading) return <ChartLoadingSkeleton height={250} />;

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-[250px]">
        <span className="text-zinc-600 text-sm">No cadence data</span>
      </div>
    );
  }

  const option = {
    backgroundColor: "transparent",
    grid: { top: 20, right: 20, bottom: 40, left: 55 },
    tooltip: {
      trigger: "item" as const,
      backgroundColor: "#18181b",
      borderColor: "#3f3f46",
      textStyle: { color: "#e4e4e7", fontSize: 12 },
      formatter: (params: { data: [string, number]; dataIndex: number }) => {
        const d = data[params.dataIndex];
        if (!d) return "";
        return `<strong>${d.activityName}</strong><br/>${d.date}<br/>Cadence: ${d.cadence} spm`;
      },
    },
    xAxis: {
      type: "time" as const,
      axisLabel: { color: "#71717a", fontSize: 11 },
      axisLine: { lineStyle: { color: "#3f3f46" } },
    },
    yAxis: {
      type: "value" as const,
      name: "Steps/min",
      splitLine: { lineStyle: { color: "#27272a" } },
      axisLabel: { color: "#71717a", fontSize: 11 },
      axisLine: { show: false },
      nameTextStyle: { color: "#71717a", fontSize: 11 },
    },
    series: [
      {
        type: "line",
        data: data.map((d) => [d.date, d.cadence]),
        smooth: true,
        symbol: "circle",
        symbolSize: 5,
        lineStyle: { width: 2, color: "#f59e0b" },
        itemStyle: { color: "#f59e0b" },
      },
    ],
  };

  return <ReactECharts option={option} style={{ height: 250 }} notMerge={true} />;
}

// ── Running Dynamics Table ──

function RunningDynamicsTable({ data, loading }: { data: DynamicsRow[]; loading: boolean }) {
  if (loading) return <ChartLoadingSkeleton height={200} />;

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-[100px]">
        <span className="text-zinc-600 text-sm">No running dynamics data</span>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-zinc-700 text-zinc-500 text-left">
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
                className="border-b border-zinc-800/50 text-zinc-300"
              >
                <td className="py-1.5 pr-3 text-zinc-500">{d.date}</td>
                <td className="py-1.5 pr-3 truncate max-w-[150px]">{d.activityName}</td>
                <td className="py-1.5 pr-3 text-right font-mono">
                  {formatPace(d.paceSecondsPerKm)}
                </td>
                <td className="py-1.5 pr-3 text-right font-mono">{d.distanceKm} km</td>
                <td className="py-1.5 pr-3 text-right font-mono">{d.cadence}</td>
                <td className="py-1.5 pr-3 text-right font-mono">
                  {d.strideLengthMeters != null ? `${d.strideLengthMeters.toFixed(2)} m` : "--"}
                </td>
                <td className="py-1.5 pr-3 text-right font-mono">
                  {d.stanceTimeMs != null ? `${Math.round(d.stanceTimeMs)} ms` : "--"}
                </td>
                <td className="py-1.5 text-right font-mono">
                  {d.verticalOscillationMm != null
                    ? `${d.verticalOscillationMm.toFixed(1)} mm`
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
        <h2 className="text-sm font-medium text-zinc-400 uppercase tracking-wider">{title}</h2>
        <ChartDescriptionTooltip description={description} />
      </div>
      {subtitle && <p className="text-xs text-zinc-600 mb-4">{subtitle}</p>}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4" title={description}>
        {children}
      </div>
    </section>
  );
}
