import { formatDateShort } from "@dofek/format/format";
import { formatMeasurementText } from "@dofek/format/units";
import { TRAINING_TERMINOLOGY } from "@dofek/training/terminology";
import type { EstimatedOneRepMaxRow } from "dofek-server/types";
import { useState } from "react";
import { dofekAxis, dofekGrid, dofekSeries, dofekTooltip, seriesColor } from "../lib/chartTheme.ts";
import { useUnitConverter } from "../lib/unitContext.ts";
import { DofekChart } from "./DofekChart.tsx";
import { MethodExplanation } from "./MethodExplanation.tsx";

interface EstimatedMaxChartProps {
  exercises: EstimatedOneRepMaxRow[];
  loading?: boolean;
}

export function EstimatedMaxChart({ exercises, loading }: EstimatedMaxChartProps) {
  const units = useUnitConverter();
  const [selectedExerciseName, setSelectedExerciseName] = useState(
    exercises[0]?.exerciseName ?? null,
  );
  const selectedExercise =
    exercises.find((exercise) => exercise.exerciseName === selectedExerciseName) ?? exercises[0];
  const selectedExerciseIndex = selectedExercise ? exercises.indexOf(selectedExercise) : 0;
  const series = selectedExercise
    ? [
        {
          ...dofekSeries.line(
            selectedExercise.exerciseName,
            selectedExercise.history.map((historyEntry) => [
              historyEntry.date,
              units.convertWeight(historyEntry.estimatedMax),
            ]),
            {
              color: seriesColor(selectedExerciseIndex),
              smooth: false,
              symbol: "circle",
              symbolSize: 5,
            },
          ),
          smooth: 0.3,
          connectNulls: true,
        },
      ]
    : [];

  const option = {
    grid: dofekGrid("single", { top: 24, bottom: 48, left: 50 }),
    tooltip: dofekTooltip(),
    xAxis: dofekAxis.time({
      axisLabel: {
        hideOverlap: true,
        showMinLabel: true,
        showMaxLabel: true,
      },
    }),
    yAxis: dofekAxis.value({
      name: `${TRAINING_TERMINOLOGY.estimatedOneRepMax.plainLabel} (${units.weightLabel})`,
    }),
    series,
  };

  return (
    <div>
      {exercises.length > 1 ? (
        <fieldset className="mb-3 flex flex-wrap gap-2">
          <legend className="sr-only">Choose an exercise to chart</legend>
          {exercises.map((exercise) => {
            const isSelected = exercise.exerciseName === selectedExercise?.exerciseName;
            return (
              <button
                key={exercise.exerciseName}
                type="button"
                aria-label={`Chart ${exercise.exerciseName}`}
                aria-pressed={isSelected}
                onClick={() => setSelectedExerciseName(exercise.exerciseName)}
                className={`rounded-lg border px-3 py-1.5 text-left text-xs transition-colors ${
                  isSelected
                    ? "border-accent bg-accent/10 text-foreground"
                    : "border-border-strong bg-accent/5 text-muted hover:bg-surface-hover hover:text-foreground"
                }`}
              >
                {exercise.exerciseName}
              </button>
            );
          })}
        </fieldset>
      ) : null}
      {selectedExercise ? (
        <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <p className="text-xs text-muted" aria-live="polite">
            <span>{selectedExercise.trend.summary}</span>{" "}
            <span className="font-mono tabular-nums text-foreground">
              {formatMeasurementText(units.formatWeight(selectedExercise.trend.changeMagnitudeKg))}
            </span>
          </p>
          <p className="text-xs text-dim tabular-nums">
            {formatDateShort(selectedExercise.trend.firstDate)} –{" "}
            {formatDateShort(selectedExercise.trend.latestDate)}
          </p>
        </div>
      ) : null}
      <DofekChart
        option={option}
        loading={loading}
        empty={exercises.length === 0}
        emptyMessage="No estimated max data"
        height={280}
      />
      <MethodExplanation
        className="mt-2"
        technicalName={TRAINING_TERMINOLOGY.estimatedOneRepMax.technicalName}
        lines={[TRAINING_TERMINOLOGY.estimatedOneRepMax.details]}
      />
    </div>
  );
}
