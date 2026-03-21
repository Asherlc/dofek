import type { MuscleGroupVolumeRow } from "dofek-server/types";
import { dofekAxis, dofekGrid, dofekLegend, dofekTooltip, seriesColor } from "../lib/chartTheme.ts";
import { DofekChart } from "./DofekChart.tsx";

interface MuscleGroupVolumeChartProps {
  data: MuscleGroupVolumeRow[];
  loading?: boolean;
}

export function MuscleGroupVolumeChart({ data, loading }: MuscleGroupVolumeChartProps) {
  // Collect all unique weeks across all muscle groups
  const allWeeks = new Set<string>();
  for (const group of data) {
    for (const w of group.weeklyData) {
      allWeeks.add(w.week);
    }
  }
  const sortedWeeks = Array.from(allWeeks).sort();

  const series = data.map((group, index) => {
    const weekMap = new Map(group.weeklyData.map((w) => [w.week, w.sets]));
    return {
      name: group.muscleGroup,
      type: "bar" as const,
      stack: "total",
      data: sortedWeeks.map((w) => [w, weekMap.get(w) ?? 0]),
      itemStyle: {
        color: seriesColor(index),
      },
      emphasis: {
        focus: "series" as const,
      },
    };
  });

  const option = {
    grid: dofekGrid("single", { top: 40, left: 50 }),
    tooltip: dofekTooltip({
      axisPointer: { type: "shadow" },
    }),
    legend: dofekLegend(true, { type: "scroll" }),
    xAxis: dofekAxis.time(),
    yAxis: dofekAxis.value({ name: "Sets" }),
    series,
  };

  return (
    <DofekChart
      option={option}
      loading={loading}
      empty={data.length === 0}
      emptyMessage="No muscle group data"
      height={320}
    />
  );
}
