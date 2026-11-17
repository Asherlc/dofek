import { formatDurationSeconds, formatNumber } from "@dofek/format/format";
import type { UnitConverter } from "@dofek/format/units";
import {
  computeIntensities,
  expandMuscleGroup,
  INTENSITY_COLORS,
  intensityToBucket,
  muscleGroupFillColor,
  muscleGroupLabel,
} from "@dofek/training/muscle-groups";
import { useEffect, useState } from "react";
import type { StrengthExerciseDetail } from "../../../../../server/src/routers/activity.ts";

function WorkoutMuscleMap({ exercises }: { exercises: StrengthExerciseDetail[] }) {
  // Lazy-load react-body-highlighter
  const [Model, setModel] = useState<typeof import("react-body-highlighter").default | null>(null);
  const [MuscleType, setMuscleType] = useState<
    typeof import("react-body-highlighter").MuscleType | null
  >(null);

  useEffect(() => {
    import("react-body-highlighter").then((mod) => {
      setModel(() => mod.default);
      setMuscleType(() => mod.MuscleType);
    });
  }, []);

  // Count sets per muscle group from this workout's exercises
  const slugTotals = new Map<string, number>();
  for (const exercise of exercises) {
    if (!exercise.muscleGroups) continue;
    for (const group of exercise.muscleGroups) {
      const slugs = expandMuscleGroup(group);
      const setsPerSlug = exercise.sets.length / slugs.length;
      for (const slug of slugs) {
        slugTotals.set(slug, (slugTotals.get(slug) ?? 0) + setsPerSlug);
      }
    }
  }

  const intensities = computeIntensities(slugTotals);
  if (intensities.size === 0 || !Model || !MuscleType) return null;

  type IExerciseData = import("react-body-highlighter").IExerciseData;
  type Muscle = import("react-body-highlighter").Muscle;
  const VALID_MUSCLES = new Set<string>(Object.values(MuscleType));
  const DELTOID_MUSCLES: Muscle[] = [MuscleType.FRONT_DELTOIDS, MuscleType.BACK_DELTOIDS];

  function isMuscle(value: string): value is Muscle {
    return VALID_MUSCLES.has(value);
  }

  const exerciseData: IExerciseData[] = [...intensities.entries()].flatMap(
    ([slug, intensity]): IExerciseData[] => {
      const bucket = intensityToBucket(intensity);
      if (bucket === 0) return [];
      if (slug === "deltoids") {
        return DELTOID_MUSCLES.map((muscle) => ({
          name: slug,
          muscles: [muscle],
          frequency: bucket,
        }));
      }
      if (!isMuscle(slug)) return [];
      return [{ name: slug, muscles: [slug], frequency: bucket }];
    },
  );

  // Build label list sorted by set count
  const labelList = [...slugTotals.entries()]
    .sort(([, countA], [, countB]) => countB - countA)
    .map(([slug, count]) => ({
      label: muscleGroupLabel(slug),
      sets: Math.round(count),
      intensity: intensities.get(slug) ?? 0,
    }));

  return (
    <div className="flex flex-col sm:flex-row items-center gap-4 mb-4">
      <div className="flex gap-4">
        <div className="flex flex-col items-center">
          <span className="text-xs text-dim mb-1">Front</span>
          <Model
            data={exerciseData}
            style={{ width: "120px" }}
            type="anterior"
            highlightedColors={INTENSITY_COLORS}
            bodyColor="#e8ede7"
          />
        </div>
        <div className="flex flex-col items-center">
          <span className="text-xs text-dim mb-1">Back</span>
          <Model
            data={exerciseData}
            style={{ width: "120px" }}
            type="posterior"
            highlightedColors={INTENSITY_COLORS}
            bodyColor="#e8ede7"
          />
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {labelList.map(({ label, sets, intensity }) => (
          <span
            key={label}
            className="text-xs px-2 py-1 rounded"
            style={{
              backgroundColor: muscleGroupFillColor(intensity),
              color: intensity > 0.5 ? "#fff" : "#1a1a1a",
            }}
          >
            {label} ({sets})
          </span>
        ))}
      </div>
    </div>
  );
}

export function StrengthExerciseBreakdown({
  exercises,
  units,
}: {
  exercises: StrengthExerciseDetail[];
  units: UnitConverter;
}) {
  return (
    <div className="space-y-4">
      <WorkoutMuscleMap exercises={exercises} />
      {exercises.map((exercise) => {
        const hasWeight = exercise.sets.some((set) => set.weightKg != null);
        const hasReps = exercise.sets.some((set) => set.reps != null);
        const hasDuration = exercise.sets.some((set) => set.durationSeconds != null);
        const hasRpe = exercise.sets.some((set) => set.rpe != null);

        return (
          <div key={`${exercise.activityId}:${exercise.exerciseIndex}`}>
            <div className="flex items-baseline gap-2 mb-2">
              <h3 className="text-sm font-medium text-foreground">{exercise.exerciseName}</h3>
              {exercise.equipment && (
                <span className="text-xs text-subtle bg-accent/10 px-1.5 py-0.5 rounded">
                  {exercise.equipment.toLowerCase().replace(/_/g, " ")}
                </span>
              )}
              {exercise.muscleGroups?.map((group) => (
                <span
                  key={group}
                  className="text-xs text-subtle bg-surface-hover px-1.5 py-0.5 rounded"
                >
                  {group.toLowerCase()}
                </span>
              ))}
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-subtle border-b border-surface-hover">
                  <th className="text-left py-1 pr-4 font-medium">Set</th>
                  {hasWeight && (
                    <th className="text-right py-1 px-4 font-medium">
                      Weight ({units.weightLabel})
                    </th>
                  )}
                  {hasReps && <th className="text-right py-1 px-4 font-medium">Reps</th>}
                  {hasDuration && <th className="text-right py-1 px-4 font-medium">Duration</th>}
                  {hasRpe && (
                    <th className="text-right py-1 pl-4 font-medium">Perceived Exertion (RPE)</th>
                  )}
                </tr>
              </thead>
              <tbody>
                {exercise.sets.map((set) => (
                  <tr key={set.setIndex} className="border-b border-surface-hover/50">
                    <td className="py-1.5 pr-4 tabular-nums text-muted">{set.setIndex + 1}</td>
                    {hasWeight && (
                      <td className="text-right py-1.5 px-4 tabular-nums">
                        {set.weightKg != null
                          ? formatNumber(units.convertWeight(set.weightKg))
                          : "—"}
                      </td>
                    )}
                    {hasReps && (
                      <td className="text-right py-1.5 px-4 tabular-nums">{set.reps ?? "—"}</td>
                    )}
                    {hasDuration && (
                      <td className="text-right py-1.5 px-4 tabular-nums">
                        {set.durationSeconds != null
                          ? formatDurationSeconds(set.durationSeconds)
                          : "—"}
                      </td>
                    )}
                    {hasRpe && (
                      <td className="text-right py-1.5 pl-4 tabular-nums">{set.rpe ?? "—"}</td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}
