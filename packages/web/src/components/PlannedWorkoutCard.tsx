import { formatDateMedium, formatDurationSeconds } from "@dofek/format/format";
import {
  formatPlannedWorkoutTarget,
  withPlannedWorkoutStepKeys,
} from "@dofek/format/planned-workout-targets";
import { providerSourceLabel } from "@dofek/providers/providers";
import { formatActivityTypeLabel } from "@dofek/training/training";
import type { AppRouterOutputs } from "dofek-server/router";
import { useId, useState } from "react";
import { useUnitConverter } from "../lib/unitContext.ts";

type PlannedWorkout = AppRouterOutputs["calendar"]["upcomingWorkouts"][number]["workouts"][number];
type PlannedWorkoutStep = PlannedWorkout["steps"][number];
type UnitConverter = ReturnType<typeof useUnitConverter>;

/** Read-only planned workout row for the Activities agenda. */
export function PlannedWorkoutCard({ workout }: { workout: PlannedWorkout }) {
  const units = useUnitConverter();
  const sportLabel = workout.sportType ? formatActivityTypeLabel(workout.sportType) : null;
  const sportIsTitle = workout.title == null && sportLabel != null;
  return (
    <article className="rounded-lg border border-border bg-surface p-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-medium text-foreground">
          {workout.title ?? sportLabel ?? "Planned workout"}
        </span>
        <span className="rounded bg-accent/10 px-1.5 py-0.5 text-[11px] font-medium text-accent">
          Planned
        </span>
      </div>
      <p className="mt-1 text-xs text-subtle">
        {workout.startTime ? `${workout.startTime} · ` : ""}
        {!sportIsTitle && sportLabel ? `${sportLabel} · ` : ""}
        {providerSourceLabel(workout.providerId)}
      </p>
      {workout.snapshotImportedAt ? (
        <p className="mt-1 text-xs text-subtle">
          Snapshot · {formatDateMedium(workout.snapshotImportedAt, { timeZone: "UTC" })}
        </p>
      ) : null}
      {workout.description ? (
        <p className="mt-1 text-sm text-muted">{workout.description}</p>
      ) : null}
      {workout.steps.length > 0 ? <WorkoutSteps steps={workout.steps} units={units} /> : null}
    </article>
  );
}

function WorkoutSteps({
  steps,
  units,
}: {
  steps: readonly PlannedWorkoutStep[];
  units: UnitConverter;
}) {
  const [expanded, setExpanded] = useState(false);
  const regionId = useId();
  return (
    <div className="mt-2">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={regionId}
        onClick={() => setExpanded((current) => !current)}
        className="text-xs font-medium text-accent hover:underline focus-visible:outline-none focus-visible:underline"
      >
        Workout steps
      </button>
      {expanded ? (
        <div id={regionId} className="mt-2">
          <StepList steps={steps} units={units} depth={0} />
        </div>
      ) : null}
    </div>
  );
}

function StepList({
  steps,
  units,
  depth,
}: {
  steps: readonly PlannedWorkoutStep[];
  units: UnitConverter;
  depth: number;
}) {
  return (
    <ul className={depth === 0 ? "space-y-1" : "ml-4 space-y-1 border-l border-border pl-3"}>
      {withPlannedWorkoutStepKeys(steps).map(([step, key]) => {
        if (step.kind === "unsupported") {
          return (
            <li key={key} className="text-sm text-subtle">
              {"Some steps aren't available."}
            </li>
          );
        }
        if (step.kind === "repeat") {
          return (
            <li key={key} className="text-sm text-muted">
              <span className="font-medium text-foreground">Repeat {step.repetitions} times</span>
              {step.text ? <span> · {step.text}</span> : null}
              {step.steps.length > 0 ? (
                <StepList steps={step.steps} units={units} depth={depth + 1} />
              ) : null}
            </li>
          );
        }
        if (step.kind === "step") {
          const details = [
            step.text,
            step.durationSeconds != null ? formatDurationSeconds(step.durationSeconds) : null,
            step.distanceMeters != null
              ? units.formatDistance(step.distanceMeters / 1000).text
              : null,
            ...step.targets.map((target) => formatPlannedWorkoutTarget(target)),
          ].filter((value): value is string => value != null && value.length > 0);
          if (details.length === 0) return null;
          return (
            <li key={key} className="text-sm text-muted">
              {details.join(" · ")}
            </li>
          );
        }
        return null;
      })}
    </ul>
  );
}
