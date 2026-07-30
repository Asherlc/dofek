import { formatMeasurementText } from "@dofek/format/units";
import type { ProgressiveOverloadRow } from "dofek-server/types";
import { chartColors, dofekAxis, dofekGrid, dofekSeries } from "../lib/chartTheme.ts";
import { useUnitConverter } from "../lib/unitContext.ts";
import { DofekChart } from "./DofekChart.tsx";

interface ProgressiveOverloadCardsProps {
  exercises: ProgressiveOverloadRow[];
  loading?: boolean;
}

function SparklineChart({ values }: { values: number[] }) {
  const option = {
    grid: dofekGrid("single", { top: 2, right: 2, bottom: 2, left: 2 }),
    xAxis: dofekAxis.category({
      data: values.map((_, i) => String(i)),
      show: false,
    }),
    yAxis: { type: "value" as const, show: false },
    series: [
      dofekSeries.line("Volume", values, {
        color: chartColors.blue,
        smooth: 0.3,
        areaStyle: { opacity: 0.1, color: chartColors.blue },
      }),
    ],
  };

  return <DofekChart option={option} height={40} />;
}

export function ProgressiveOverloadCards({ exercises, loading }: ProgressiveOverloadCardsProps) {
  const units = useUnitConverter();

  if (loading || exercises.length === 0) {
    return (
      <DofekChart
        option={{}}
        loading={loading}
        empty={exercises.length === 0}
        height={200}
        emptyMessage="No exercise volume trends"
      />
    );
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {exercises.map((exercise) => (
        <div key={exercise.exerciseName} className="card p-4">
          <div className="text-sm font-medium text-foreground truncate mb-2">
            {exercise.exerciseName}
          </div>
          <div className="text-xs text-muted mb-2">
            {trendLabel(exercise.trend)}{" "}
            {formatMeasurementText(units.formatWeight(Math.abs(exercise.slopeKgPerWeek)))}/week
          </div>
          {exercise.weeklyVolumes.length >= 2 && <SparklineChart values={exercise.weeklyVolumes} />}
        </div>
      ))}
    </div>
  );
}

function trendLabel(trend: ProgressiveOverloadRow["trend"]): string {
  if (trend === "increasing") return "Increasing";
  if (trend === "decreasing") return "Decreasing";
  return "Stable";
}
