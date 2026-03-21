import type { EstimatedOneRepMaxRow } from "dofek-server/types";
import {
  dofekAxis,
  dofekGrid,
  dofekLegend,
  dofekSeries,
  dofekTooltip,
  seriesColor,
} from "../lib/chartTheme.ts";
import { DofekChart } from "./DofekChart.tsx";

interface EstimatedMaxChartProps {
  exercises: EstimatedOneRepMaxRow[];
  loading?: boolean;
}

export function EstimatedMaxChart({ exercises, loading }: EstimatedMaxChartProps) {
  const series = exercises.map((exercise, index) => ({
    ...dofekSeries.line(
      exercise.exerciseName,
      exercise.history.map((h) => [h.date, h.estimatedMax]),
      {
        color: seriesColor(index),
        smooth: false,
        symbol: "circle",
        symbolSize: 5,
      },
    ),
    smooth: 0.3,
    connectNulls: true,
  }));

  const option = {
    grid: dofekGrid("single", { top: 40, left: 50 }),
    tooltip: dofekTooltip(),
    legend: dofekLegend(true, {
      type: "scroll",
      data: undefined,
    }),
    xAxis: dofekAxis.time(),
    yAxis: dofekAxis.value({ name: "Estimated 1-Rep Max (kg)" }),
    series,
  };

  return (
    <DofekChart
      option={option}
      loading={loading}
      empty={exercises.length === 0}
      emptyMessage="No estimated max data"
      height={320}
    />
  );
}
