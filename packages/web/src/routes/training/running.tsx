import { formatDateMedium, formatNumber, formatPace } from "@dofek/format/format";
import type { UnitConverter } from "@dofek/format/units";
import { createFileRoute } from "@tanstack/react-router";
import type { TrainingChartAvailability } from "dofek-server/types";
import { DofekChart } from "../../components/DofekChart.tsx";
import { QueryStatePanel } from "../../components/QueryStatePanel.tsx";
import { RecentActivitiesSection } from "../../components/RecentActivitiesSection.tsx";
import { RunningDynamics } from "../../components/RunningDynamics.tsx";
import { SportVolumeChart } from "../../components/SportVolumeChart.tsx";
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
      <div className="card p-4">
        <SportVolumeChart days={days} sport="running" />
      </div>
      {paceCurve.error && paceCurve.data && <QueryStatePanel error={paceCurve.error} />}
      {paceTrend.error && paceTrend.data && <QueryStatePanel error={paceTrend.error} />}
      {/* Pace Duration Curve */}
      <Section title="Pace Duration Curve">
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
        <Section title="Pace Trend">
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
      </div>
      <RunningDynamics data={dynamics.data} loading={dynamics.isLoading} error={dynamics.error} />

      <Section title="Recent Runs">
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

// ── Section helper ──

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="mb-1 flex items-center gap-2">
        <h2 className="text-sm font-medium text-muted uppercase tracking-wider">{title}</h2>
      </div>
      <div className="card p-4">{children}</div>
    </section>
  );
}
