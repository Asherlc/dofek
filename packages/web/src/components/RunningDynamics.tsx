import { formatDateMedium } from "@dofek/format/format";
import { runningCadenceLabel } from "@dofek/training/running-cadence";
import {
  RUNNING_DYNAMICS_INVALID_RESPONSE_MESSAGE,
  type RunningDynamicsResponseV2,
  runningDynamicsResponseV2Schema,
} from "@dofek/training/running-response";
import type { TrainingChartAvailability } from "@dofek/training/training-chart-availability";
import { useEffect, useMemo } from "react";
import {
  chartColors,
  dofekAxis,
  dofekGrid,
  dofekLegend,
  dofekSeries,
  dofekTooltip,
  escapeTooltipHtml,
} from "../lib/chartTheme.ts";
import { captureException } from "../lib/telemetry.ts";
import { DofekChart } from "./DofekChart.tsx";
import { QueryStatePanel } from "./QueryStatePanel.tsx";
import { TrainingChartEmptyState } from "./TrainingChartEmptyState.tsx";

type DynamicsRow = RunningDynamicsResponseV2["data"][number];
export function RunningDynamics({
  data: rawData,
  loading,
  error,
}: {
  data: unknown;
  loading: boolean;
  error: { message: string } | null;
}) {
  const parsed = useMemo(
    () => (rawData === undefined ? undefined : runningDynamicsResponseV2Schema.safeParse(rawData)),
    [rawData],
  );
  const failure = parsed && !parsed.success ? parsed.error : undefined;
  useEffect(() => {
    if (failure) captureException(failure, { context: "Running data" });
  }, [failure]);
  const data = parsed?.success ? parsed.data : undefined;
  return (
    <>
      {error && <QueryStatePanel error={error} />}
      {failure && (
        <QueryStatePanel error={{ message: RUNNING_DYNAMICS_INVALID_RESPONSE_MESSAGE }} />
      )}
      {!failure && (!error || data) && (
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
