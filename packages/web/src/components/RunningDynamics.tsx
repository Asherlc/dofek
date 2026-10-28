import { formatDateMedium, formatNumber, formatPace } from "@dofek/format/format";
import type { UnitConverter } from "@dofek/format/units";
import { runningCadenceLabel } from "@dofek/training/running-cadence";
import type { RunningDynamicsRow, TrainingChartAvailability } from "dofek-server/types";
import {
  chartColors,
  dofekAxis,
  dofekGrid,
  dofekLegend,
  dofekSeries,
  dofekTooltip,
  escapeTooltipHtml,
} from "../lib/chartTheme.ts";
import { useUnitConverter } from "../lib/unitContext.ts";
import { ActivityTable, type ActivityTableColumn } from "./ActivityTable.tsx";
import { DofekChart } from "./DofekChart.tsx";
import { ChartLoadingSkeleton } from "./LoadingSkeleton.tsx";
import { QueryStatePanel } from "./QueryStatePanel.tsx";
import { TrainingChartEmptyState } from "./TrainingChartEmptyState.tsx";

type DynamicsRow = RunningDynamicsRow;
export interface RunningDynamicsData {
  data: RunningDynamicsRow[];
  availability: TrainingChartAvailability;
  cadenceAvailability: TrainingChartAvailability;
}
export function RunningDynamics({
  data,
  loading,
  error,
}: {
  data: RunningDynamicsData | undefined;
  loading: boolean;
  error: { message: string } | null;
}) {
  const units = useUnitConverter();
  return (
    <>
      {error && <QueryStatePanel error={error} />}
      {(!error || data) && (
        <>
          <section>
            <h2 className="mb-1 text-sm font-medium text-muted uppercase tracking-wider">
              Cadence Trend
            </h2>
            <div className="card p-4">
              <CadenceTrendChart
                data={data?.data ?? []}
                availability={data?.cadenceAvailability}
                loading={loading && !data}
              />
            </div>
          </section>
          <section>
            <h2 className="mb-1 text-sm font-medium text-muted uppercase tracking-wider">
              Running Form
            </h2>
            <div className="card p-4">
              <RunningDynamicsTable
                data={data?.data ?? []}
                availability={data?.availability}
                loading={loading && !data}
                units={units}
              />
            </div>
          </section>
        </>
      )}
    </>
  );
}

// ── Cadence Trend Chart ──

function CadenceTrendChart({
  data,
  availability,
  loading,
}: {
  data: DynamicsRow[];
  availability?: TrainingChartAvailability;
  loading: boolean;
}) {
  const cadenceRows = data.filter((row) => row.cadence !== null);
  const option = {
    grid: { ...dofekGrid("single"), top: 20, bottom: 40, left: 55 },
    tooltip: dofekTooltip({
      trigger: "item",
      formatter: (params: { data: [string, number]; dataIndex: number }) => {
        const dataPoint = cadenceRows[params.dataIndex];
        if (!dataPoint) return "";
        return `<strong>${escapeTooltipHtml(dataPoint.activityName)}</strong><br/>${escapeTooltipHtml(formatDateMedium(dataPoint.date))}<br/>Cadence: ${dataPoint.cadence} spm<br/>${runningCadenceLabel(dataPoint)}`;
      },
    }),
    xAxis: dofekAxis.time(),
    yAxis: dofekAxis.value({ name: "Steps/min" }),
    legend: dofekLegend(false),
    series: [
      dofekSeries.line(
        "Cadence",
        cadenceRows.map((d) => [d.date, d.cadence]),
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
      empty={cadenceRows.length === 0}
      height={250}
      emptyMessage="No cadence samples or usable imported step intervals"
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
        row.paceSecondsPerKm == null
          ? "--"
          : `${formatPace(units.convertPace(row.paceSecondsPerKm))} ${units.paceLabel}`,
    },
    {
      key: "distance",
      label: "Distance",
      headerClassName: "py-2 pr-3 text-right",
      cellClassName: "py-1.5 pr-3 text-right font-mono",
      renderCell: (row) =>
        row.distanceKm == null
          ? "--"
          : `${formatNumber(units.convertDistance(row.distanceKm))} ${units.distanceLabel}`,
    },
    {
      key: "cadence",
      label: "Cadence",
      headerClassName: "py-2 pr-3 text-right",
      cellClassName: "py-1.5 pr-3 text-right font-mono",
      renderCell: (row) =>
        row.cadence == null ? (
          "--"
        ) : (
          <div>
            <span>{row.cadence}</span>
            <div className="text-dim text-[10px] font-sans">{runningCadenceLabel(row)}</div>
          </div>
        ),
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
      label: "Ground Contact",
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
