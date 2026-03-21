import type { ProgressiveOverloadRow } from "dofek-server/types";
import { dofekAxis, dofekGrid, dofekSeries } from "../lib/chartTheme.ts";
import { formatNumber } from "../lib/format.ts";
import { DofekChart } from "./DofekChart.tsx";

interface ProgressiveOverloadCardsProps {
  exercises: ProgressiveOverloadRow[];
  loading?: boolean;
}

function SparklineChart({ values, isProgressing }: { values: number[]; isProgressing: boolean }) {
  const color = isProgressing ? "#10b981" : "#ef4444";

  const option = {
    grid: dofekGrid("single", { top: 2, right: 2, bottom: 2, left: 2 }),
    xAxis: dofekAxis.category({
      data: values.map((_, i) => String(i)),
      show: false,
    }),
    yAxis: { type: "value" as const, show: false },
    series: [
      dofekSeries.line("Volume", values, {
        color,
        smooth: 0.3,
        areaStyle: { opacity: 0.1, color },
      }),
    ],
  };

  return <DofekChart option={option} height={40} />;
}

export function ProgressiveOverloadCards({ exercises, loading }: ProgressiveOverloadCardsProps) {
  if (loading || exercises.length === 0) {
    return (
      <DofekChart
        option={{}}
        loading={loading}
        empty={exercises.length === 0}
        height={200}
        emptyMessage="No progressive overload data"
      />
    );
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {exercises.map((exercise) => (
        <div key={exercise.exerciseName} className="card p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-foreground truncate">
              {exercise.exerciseName}
            </span>
            <span className={`text-lg ${exercise.isProgressing ? "text-accent" : "text-red-400"}`}>
              {exercise.isProgressing ? "\u2191" : "\u2193"}
            </span>
          </div>
          <div className="text-xs text-muted mb-2">
            {exercise.isProgressing ? "+" : ""}
            {formatNumber(exercise.slopeKgPerWeek)} kg/week
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
