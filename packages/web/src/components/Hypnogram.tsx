import { formatDurationSeconds, formatTimeOnly } from "@dofek/format/format";
import { sleepStageColors } from "@dofek/scoring/colors";
import type { CustomSeriesRenderItem } from "echarts";
import { useState } from "react";
import { chartThemeColors, dofekAxis, dofekGrid } from "../lib/chartTheme.ts";
import { DofekChart } from "./DofekChart.tsx";

interface SleepStage {
  stage: string;
  started_at: string;
  ended_at: string;
  duration_seconds: number;
}

interface HypnogramProps {
  data: SleepStage[];
  loading?: boolean;
}

const STAGES = [
  { key: "awake", label: "Awake", color: sleepStageColors.awake },
  { key: "rem", label: "REM", color: sleepStageColors.rem },
  { key: "light", label: "Light", color: sleepStageColors.light },
  { key: "deep", label: "Deep", color: sleepStageColors.deep },
];

export function Hypnogram({ data, loading }: HypnogramProps) {
  const [selection, setSelection] = useState<SleepStage | null>(null);
  const selected = selection && data.includes(selection) ? selection : null;
  const selectedStage = STAGES.find((stage) => stage.key === selected?.stage);
  const renderItem: CustomSeriesRenderItem = (params, api) => {
    const interval = data[params.dataIndex];
    const stage = STAGES.find((stage) => stage.key === interval?.stage);
    if (!stage) return;
    const [startX = 0, centerY = 0] = api.coord([api.value(1), api.value(0)]);
    const [endX = 0] = api.coord([api.value(2), api.value(0)]);
    return {
      type: "rect",
      shape: { x: startX, y: centerY - 12, width: endX - startX, height: 24, r: 3 },
      style: {
        fill: stage.color,
        opacity: 1,
        stroke: selected === interval ? chartThemeColors.tooltipText : undefined,
        lineWidth: selected === interval ? 2 : 0,
      },
      emphasis: { style: { stroke: chartThemeColors.tooltipText, lineWidth: 2 } },
    };
  };
  const option = {
    animation: false,
    grid: dofekGrid("single", { top: 12, bottom: 36, left: 55, right: 15 }),
    xAxis: {
      ...dofekAxis.time({ show: true }),
      min: "dataMin",
      max: "dataMax",
      splitNumber: 5,
      axisLabel: {
        color: chartThemeColors.axisLabel,
        fontSize: 11,
        hideOverlap: true,
        formatter: (value: number) => formatTimeOnly(new Date(value).toISOString()),
      },
    },
    yAxis: {
      type: "category",
      inverse: true,
      data: STAGES.map((stage) => stage.label),
      axisLabel: { color: chartThemeColors.axisLabel, fontSize: 11 },
      axisTick: { show: false },
      axisLine: { show: false },
      splitLine: { show: true, lineStyle: { color: chartThemeColors.gridLine } },
    },
    series: [
      {
        type: "custom",
        name: "Sleep stages",
        renderItem,
        encode: { x: [1, 2], y: 0 },
        data: data.map((interval) => [
          STAGES.findIndex((stage) => stage.key === interval.stage),
          Date.parse(interval.started_at),
          Date.parse(interval.ended_at),
        ]),
      },
    ],
  };

  function selectInterval(event: Record<string, unknown>) {
    if (typeof event.dataIndex === "number") setSelection(data[event.dataIndex] ?? null);
  }

  return (
    <>
      <DofekChart
        option={option}
        loading={loading}
        empty={data.length === 0}
        height={240}
        emptyMessage="No sleep stage data available"
        timeRangeMode="data"
        onEvents={{ mouseover: selectInterval, click: selectInterval }}
        dataDisclosure={
          <details className="mt-2 text-xs text-dim">
            <summary className="cursor-pointer font-medium text-foreground">
              View chart data
            </summary>
            <div className="mt-2 max-h-72 overflow-auto rounded-lg border border-border">
              <table className="w-full text-left">
                <caption className="sr-only">Recorded sleep-stage intervals</caption>
                <thead>
                  <tr>
                    {["Stage", "Start", "End", "Duration"].map((label) => (
                      <th key={label} scope="col" className="px-3 py-2">
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.map((interval) => (
                    <tr
                      key={`${interval.stage}-${interval.started_at}-${interval.ended_at}`}
                      className="border-t border-border"
                    >
                      <th scope="row" className="px-3 py-2">
                        <button
                          type="button"
                          className="rounded underline underline-offset-2 focus-visible:outline-2"
                          onClick={() => setSelection(interval)}
                          aria-pressed={selected === interval}
                          aria-label={`Select ${STAGES.find((stage) => stage.key === interval.stage)?.label} interval starting ${formatTimeOnly(interval.started_at, { seconds: true })}`}
                        >
                          {STAGES.find((stage) => stage.key === interval.stage)?.label}
                        </button>
                      </th>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {formatTimeOnly(interval.started_at, { seconds: true })}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {formatTimeOnly(interval.ended_at, { seconds: true })}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {formatDurationSeconds(interval.duration_seconds, { precision: "second" })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        }
      />
      {!loading && data.length > 0 && (
        <div
          role="status"
          className="mt-3 flex min-h-16 items-center gap-3 rounded-lg border border-border px-4 py-3 text-sm"
        >
          {selected && selectedStage ? (
            <>
              <span
                className="h-8 w-1 rounded-full"
                style={{ backgroundColor: selectedStage.color }}
              />
              <div>
                <div className="font-medium">{selectedStage.label}</div>
                <div className="text-xs text-muted">
                  {formatTimeOnly(selected.started_at, { seconds: true })} –{" "}
                  {formatTimeOnly(selected.ended_at, { seconds: true })}
                </div>
              </div>
              <span className="ml-auto whitespace-nowrap font-medium">
                {formatDurationSeconds(selected.duration_seconds, { precision: "second" })}
              </span>
            </>
          ) : (
            <span className="text-xs text-muted">Select a sleep stage to see its interval.</span>
          )}
        </div>
      )}
    </>
  );
}
