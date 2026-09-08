import { formatDateShort } from "@dofek/format/format";
import { formatMeasurementText } from "@dofek/format/units";
import { TRAINING_TERMINOLOGY } from "@dofek/training/terminology";
import {
  isSameStrengthExercise,
  type StrengthExerciseIdentity,
  strengthExerciseDisplayLabels,
  strengthExerciseIdentityKey,
} from "@dofek/training/training";
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
  const [selectedIdentity, setSelectedIdentity] = useState<StrengthExerciseIdentity | null>(
    exercises[0]
      ? { exerciseName: exercises[0].exerciseName, equipment: exercises[0].equipment }
      : null,
  );
  const exerciseLabels = strengthExerciseDisplayLabels(exercises);
  const selectedExercise =
    exercises.find(
      (exercise) => selectedIdentity && isSameStrengthExercise(exercise, selectedIdentity),
    ) ?? exercises[0];
  const selectedExerciseIndex = selectedExercise ? exercises.indexOf(selectedExercise) : 0;
  const selectedExerciseLabel = exerciseLabels[selectedExerciseIndex]?.label ?? null;
  const series = selectedExercise
    ? [
        {
          ...dofekSeries.line(
            selectedExerciseLabel ?? selectedExercise.exerciseName,
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
          {exercises.map((exercise, exerciseIndex) => {
            const label = exerciseLabels[exerciseIndex]?.label ?? exercise.exerciseName;
            const isSelected = selectedExercise
              ? isSameStrengthExercise(exercise, selectedExercise)
              : false;
            return (
              <button
                key={strengthExerciseIdentityKey(exercise)}
                type="button"
                aria-label={`Chart ${label}`}
                aria-pressed={isSelected}
                onClick={() =>
                  setSelectedIdentity({
                    exerciseName: exercise.exerciseName,
                    equipment: exercise.equipment,
                  })
                }
                className={`rounded-lg border px-3 py-1.5 text-left text-xs transition-colors ${
                  isSelected
                    ? "border-accent bg-accent/10 text-foreground"
                    : "border-border-strong bg-accent/5 text-muted hover:bg-surface-hover hover:text-foreground"
                }`}
              >
                {label}
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
