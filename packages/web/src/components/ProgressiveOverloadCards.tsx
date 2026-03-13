import type { ProgressiveOverloadRow } from "dofek-server/types";
import ReactECharts from "echarts-for-react";
import { ChartLoadingSkeleton } from "./LoadingSkeleton.tsx";

interface ProgressiveOverloadCardsProps {
  exercises: ProgressiveOverloadRow[];
  loading?: boolean;
}

function SparklineChart({ values, isProgressing }: { values: number[]; isProgressing: boolean }) {
  const color = isProgressing ? "#10b981" : "#ef4444";

  const option = {
    backgroundColor: "transparent",
    grid: { top: 2, right: 2, bottom: 2, left: 2 },
    xAxis: {
      type: "category",
      show: false,
      data: values.map((_, i) => i),
    },
    yAxis: {
      type: "value",
      show: false,
    },
    series: [
      {
        type: "line",
        data: values,
        smooth: 0.3,
        symbol: "none",
        lineStyle: { width: 2, color },
        areaStyle: { color, opacity: 0.1 },
      },
    ],
  };

  return <ReactECharts option={option} style={{ height: 40, width: "100%" }} />;
}

export function ProgressiveOverloadCards({ exercises, loading }: ProgressiveOverloadCardsProps) {
  if (loading) {
    return <ChartLoadingSkeleton height={200} />;
  }

  if (exercises.length === 0) {
    return (
      <div className="flex items-center justify-center h-[200px]">
        <span className="text-zinc-600 text-sm">No progressive overload data</span>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {exercises.map((exercise) => (
        <div
          key={exercise.exerciseName}
          className="rounded-lg border border-zinc-800 bg-zinc-900 p-4"
        >
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-zinc-100 truncate">
              {exercise.exerciseName}
            </span>
            <span
              className={`text-lg ${exercise.isProgressing ? "text-emerald-400" : "text-red-400"}`}
            >
              {exercise.isProgressing ? "\u2191" : "\u2193"}
            </span>
          </div>
          <div className="text-xs text-zinc-400 mb-2">
            {exercise.isProgressing ? "+" : ""}
            {exercise.slopeKgPerWeek.toFixed(1)} kg/week
          </div>
          {exercise.weeklyVolumes.length >= 2 && (
            <SparklineChart
              values={exercise.weeklyVolumes}
              isProgressing={exercise.isProgressing}
            />
          )}
        </div>
      ))}
    </div>
  );
}
