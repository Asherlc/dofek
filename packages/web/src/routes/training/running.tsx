import { formatDateMedium, formatNumber, formatPace } from "@dofek/format/format";
import type { UnitConverter } from "@dofek/format/units";
import { createFileRoute } from "@tanstack/react-router";
import type { TrainingChartAvailability } from "dofek-server/types";
import { ActivityTable, type ActivityTableColumn } from "../../components/ActivityTable.tsx";
import { ChartDescriptionTooltip } from "../../components/ChartDescriptionTooltip.tsx";
import { DofekChart } from "../../components/DofekChart.tsx";
import { ChartLoadingSkeleton } from "../../components/LoadingSkeleton.tsx";
import { QueryStatePanel } from "../../components/QueryStatePanel.tsx";
import { RecentActivitiesSection } from "../../components/RecentActivitiesSection.tsx";
import { TrainingChartEmptyState } from "../../components/TrainingChartEmptyState.tsx";
import {
  chartColors,
  dofekAxis,
  dofekGrid,
  dofekLegend,
  dofekSeries,
  dofekTooltip,
  escapeTooltipHtml,
} from "../../lib/chartTheme.ts";
import { selectedRangeQueryInput } from "../../lib/timeRange.ts";
import { useTrainingDays } from "../../lib/trainingDaysContext.ts";
import { TRAINING_SLOW_QUERY_OPTIONS } from "../../lib/trainingQueryOptions.ts";
import { trpc } from "../../lib/trpc.ts";
import { useUnitConverter } from "../../lib/unitContext.ts";

export const Route = createFileRoute("/training/running")({
  component: RunningTab,
});

const RUNNING_ACTIVITY_TYPES = ["running"] as const;

export function RunningTab() {
  const { days } = useTrainingDays();
  const units = useUnitConverter();

  const paceCurve = trpc.durationCurves.paceCurve.useQuery(
    selectedRangeQueryInput(days),
    TRAINING_SLOW_QUERY_OPTIONS,
  );
  const paceTrend = trpc.running.paceTrendV2.useQuery(selectedRangeQueryInput(days));
  const dynamics = trpc.running.dynamicsV2.useQuery(selectedRangeQueryInput(days));

  return (
    <>
      {/* Pace Duration Curve */}
      <Section title="Pace Duration Curve" subtitle="Best sustained pace at each duration">
        {paceCurve.error && !paceCurve.data ? (
          <QueryStatePanel error={paceCurve.error} />
        ) : (
          <PaceCurveChart
            data={paceCurve.data?.points ?? []}
            availability={paceCurve.data?.availability}
            loading={paceCurve.isLoading}
            units={units}
          />
        )}
      </Section>

      {/* Pace Trend + Running Dynamics side by side */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Section title="Pace Trend" subtitle="Average pace per run over time">
          {paceTrend.error && !paceTrend.data ? (
            <QueryStatePanel error={paceTrend.error} />
          ) : (
            <PaceTrendChart
              data={paceTrend.data?.data ?? []}
              availability={paceTrend.data?.availability}
              loading={paceTrend.isLoading}
              units={units}
            />
          )}
        </Section>

        <Section title="Cadence Trend" subtitle="Steps per minute over time">
          {dynamics.error && !dynamics.data ? (
            <QueryStatePanel error={dynamics.error} />
          ) : (
            <CadenceTrendChart
              data={dynamics.data?.data ?? []}
              availability={dynamics.data?.availability}
              loading={dynamics.isLoading}
            />
          )}
        </Section>
      </div>

      {/* Running Dynamics Table */}
      <Section title="Running Form" subtitle="Per-activity running dynamics">
        {dynamics.error && !dynamics.data ? (
          <QueryStatePanel error={dynamics.error} />
        ) : (
          <RunningDynamicsTable
            data={dynamics.data?.data ?? []}
            availability={dynamics.data?.availability}
            loading={dynamics.isLoading}
            units={units}
          />
        )}
      </Section>

      <Section title="Recent Runs" subtitle="Recent running activities">
        <RecentActivitiesSection activityTypes={RUNNING_ACTIVITY_TYPES} />
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
  availability,
  loading,
  units,
}: {
  data: PaceCurvePoint[];
  availability?: TrainingChartAvailability;
  loading: boolean;
  units: UnitConverter;
}) {
  if (!loading && availability?.status === "insufficient_data") {
    return <TrainingChartEmptyState availability={availability} />;
  }

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
        return `${durLabel}: <strong>${formatPace(pace)} ${escapeTooltipHtml(units.paceLabel)}</strong>`;
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
        name: `Pace (min${units.paceLabel})`,
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
        data.map((d) => [d.durationSeconds, units.convertPace(d.bestPaceSecondsPerKm)]),
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
  availability,
  loading,
  units,
}: {
  data: PaceTrendPoint[];
  availability?: TrainingChartAvailability;
  loading: boolean;
  units: UnitConverter;
}) {
  const option = {
    grid: { ...dofekGrid("single"), top: 20, bottom: 40, left: 65 },
    tooltip: dofekTooltip({
      trigger: "item",
      formatter: (params: { data: [string, number]; dataIndex: number }) => {
        const dataPoint = data[params.dataIndex];
        if (!dataPoint) return "";
        return [
          `<strong>${escapeTooltipHtml(dataPoint.activityName)}</strong>`,
          escapeTooltipHtml(formatDateMedium(dataPoint.date)),
          `Pace: ${formatPace(units.convertPace(dataPoint.paceSecondsPerKm))} ${escapeTooltipHtml(units.paceLabel)}`,
          `Distance: ${formatNumber(units.convertDistance(dataPoint.distanceKm))} ${escapeTooltipHtml(units.distanceLabel)} · ${dataPoint.durationMinutes} min`,
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
        data: data.map((d) => [d.date, units.convertPace(d.paceSecondsPerKm)]),
        symbolSize: (val: [string, number]) => {
          const matchedActivity = data.find(
            (point) => units.convertPace(point.paceSecondsPerKm) === val[1],
          );
          return Math.min(Math.max((matchedActivity?.distanceKm ?? 5) * 1.5, 4), 16);
        },
        itemStyle: { color: chartColors.emerald, opacity: 0.7 },
      },
    ],
  };

  if (!loading && availability?.status === "insufficient_data") {
    return <TrainingChartEmptyState availability={availability} />;
  }

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
  activityId: string;
  date: string;
  activityName: string;
  cadence: number;
  strideLengthMeters: number | null;
  stanceTimeMs: number | null;
  verticalOscillationMm: number | null;
  paceSecondsPerKm: number;
  distanceKm: number;
}

function CadenceTrendChart({
  data,
  availability,
  loading,
}: {
  data: DynamicsRow[];
  availability?: TrainingChartAvailability;
  loading: boolean;
}) {
  const option = {
    grid: { ...dofekGrid("single"), top: 20, bottom: 40, left: 55 },
    tooltip: dofekTooltip({
      trigger: "item",
      formatter: (params: { data: [string, number]; dataIndex: number }) => {
        const dataPoint = data[params.dataIndex];
        if (!dataPoint) return "";
        return `<strong>${escapeTooltipHtml(dataPoint.activityName)}</strong><br/>${escapeTooltipHtml(formatDateMedium(dataPoint.date))}<br/>Cadence: ${dataPoint.cadence} spm`;
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

  if (!loading && availability?.status === "insufficient_data") {
    return <TrainingChartEmptyState availability={availability} />;
  }

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
  availability,
  loading,
  units,
}: {
  data: DynamicsRow[];
  availability?: TrainingChartAvailability;
  loading: boolean;
  units: UnitConverter;
}) {
  if (loading) return <ChartLoadingSkeleton height={200} />;

  if (availability?.status === "insufficient_data") {
    return <TrainingChartEmptyState availability={availability} />;
  }

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-[100px]">
        <span className="text-dim text-sm">No running dynamics data</span>
      </div>
    );
  }

  const columns: ActivityTableColumn<DynamicsRow>[] = [
    {
      key: "date",
      label: "Date",
      headerClassName: "py-2 pr-3",
      cellClassName: "py-1.5 pr-3 text-subtle",
      renderCell: (row) => formatDateMedium(row.date),
    },
    {
      key: "activity",
      label: "Activity",
      headerClassName: "py-2 pr-3",
      cellClassName: "py-1.5 pr-3 truncate max-w-[150px]",
      renderCell: (row) => row.activityName,
    },
    {
      key: "pace",
      label: "Pace",
      headerClassName: "py-2 pr-3 text-right",
      cellClassName: "py-1.5 pr-3 text-right font-mono",
      renderCell: (row) =>
        `${formatPace(units.convertPace(row.paceSecondsPerKm))} ${units.paceLabel}`,
    },
    {
      key: "distance",
      label: "Distance",
      headerClassName: "py-2 pr-3 text-right",
      cellClassName: "py-1.5 pr-3 text-right font-mono",
      renderCell: (row) =>
        `${formatNumber(units.convertDistance(row.distanceKm))} ${units.distanceLabel}`,
    },
    {
      key: "cadence",
      label: "Cadence",
      headerClassName: "py-2 pr-3 text-right",
      cellClassName: "py-1.5 pr-3 text-right font-mono",
      renderCell: (row) => row.cadence,
    },
    {
      key: "stride",
      label: "Stride",
      headerClassName: "py-2 pr-3 text-right",
      cellClassName: "py-1.5 pr-3 text-right font-mono",
      renderCell: (row) =>
        row.strideLengthMeters != null ? `${formatNumber(row.strideLengthMeters, 2)} m` : "--",
    },
    {
      key: "stanceTime",
      label: "Stance Time",
      headerClassName: "py-2 pr-3 text-right",
      cellClassName: "py-1.5 pr-3 text-right font-mono",
      renderCell: (row) => (row.stanceTimeMs != null ? `${Math.round(row.stanceTimeMs)} ms` : "--"),
    },
    {
      key: "verticalOscillation",
      label: "Vert. Osc.",
      headerClassName: "py-2 text-right",
      cellClassName: "py-1.5 text-right font-mono",
      renderCell: (row) =>
        row.verticalOscillationMm != null ? `${formatNumber(row.verticalOscillationMm)} mm` : "--",
    },
  ];

  return (
    <ActivityTable
      rows={data.slice().reverse()}
      columns={columns}
      getRowKey={(row) => `${row.activityId}-${row.date}-${row.activityName}`}
      getActivityId={(row) => row.activityId}
      tableClassName="w-full text-xs"
      headerRowClassName="border-b border-border-strong text-subtle text-left"
      rowClassName="border-b border-border/50 text-foreground hover:bg-surface-hover cursor-pointer"
    />
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
