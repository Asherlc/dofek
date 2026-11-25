import { formatDateMedium, formatDurationSeconds } from "@dofek/format/format";
import {
  formatPlannedWorkoutTarget,
  withPlannedWorkoutStepKeys,
} from "@dofek/format/planned-workout-targets";
import { providerSourceLabel } from "@dofek/providers/providers";
import { formatActivityTypeLabel } from "@dofek/training/training";
import type { AppRouterOutputs } from "dofek-server/router";
import { useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useUnitConverter } from "../lib/units";
import { colors, spacing } from "../theme";

type PlannedWorkout = AppRouterOutputs["calendar"]["upcomingWorkouts"][number]["workouts"][number];
type PlannedWorkoutStep = PlannedWorkout["steps"][number];
type UnitConverter = ReturnType<typeof useUnitConverter>;

/** Read-only planned workout row for the Activities agenda. */
export function PlannedWorkoutCard({ workout }: { workout: PlannedWorkout }) {
  const units = useUnitConverter();
  const sportLabel = workout.sportType ? formatActivityTypeLabel(workout.sportType) : null;
  const sportIsTitle = workout.title == null && sportLabel != null;
  return (
    <View style={styles.card}>
      <View style={styles.titleRow}>
        <Text style={styles.title}>{workout.title ?? sportLabel ?? "Planned workout"}</Text>
        <Text style={styles.plannedPill}>Planned</Text>
      </View>
      <Text style={styles.meta}>
        {workout.startTime ? `${workout.startTime} · ` : ""}
        {!sportIsTitle && sportLabel ? `${sportLabel} · ` : ""}
        {providerSourceLabel(workout.providerId)}
      </Text>
      {workout.snapshotImportedAt ? (
        <Text style={styles.meta}>
          Snapshot · {formatDateMedium(workout.snapshotImportedAt, { timeZone: "UTC" })}
        </Text>
      ) : null}
      {workout.description ? <Text style={styles.description}>{workout.description}</Text> : null}
      {workout.steps.length > 0 ? <WorkoutSteps steps={workout.steps} units={units} /> : null}
    </View>
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
  return (
    <View style={styles.steps}>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel="Workout steps"
        accessibilityState={{ expanded }}
        activeOpacity={0.7}
        onPress={() => setExpanded((current) => !current)}
      >
        <Text style={styles.disclosure}>Workout steps</Text>
      </TouchableOpacity>
      {expanded ? <StepList steps={steps} units={units} depth={0} /> : null}
    </View>
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
    <View style={depth > 0 ? styles.nestedSteps : undefined}>
      {withPlannedWorkoutStepKeys(steps).map(([step, key]) => {
        if (step.kind === "unsupported") {
          return (
            <Text key={key} style={styles.stepText}>
              {"Some steps aren't available."}
            </Text>
          );
        }
        if (step.kind === "repeat") {
          return (
            <View key={key} style={styles.stepRow}>
              <Text style={styles.stepText}>
                Repeat {step.repetitions} times{step.text ? ` · ${step.text}` : ""}
              </Text>
              {step.steps.length > 0 ? (
                <StepList steps={step.steps} units={units} depth={depth + 1} />
              ) : null}
            </View>
          );
        }
        if (step.kind === "step") {
          const details = [
            step.text,
            step.durationSeconds != null
              ? formatDurationSeconds(step.durationSeconds, { precision: "second" })
              : null,
            step.distanceMeters != null
              ? units.formatDistance(step.distanceMeters / 1000).text
              : null,
            ...step.targets.map((target) => formatPlannedWorkoutTarget(target)),
          ].filter((value): value is string => value != null && value.length > 0);
          if (details.length === 0) return null;
          return (
            <Text key={key} style={styles.stepText}>
              {details.join(" · ")}
            </Text>
          );
        }
        return null;
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: spacing.md,
    gap: spacing.xs,
  },
  titleRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 8 },
  title: { color: colors.text, fontSize: 15, fontWeight: "600", flexShrink: 1 },
  plannedPill: {
    color: colors.accent,
    backgroundColor: colors.accentSubtle,
    borderRadius: 6,
    fontSize: 11,
    fontWeight: "600",
    overflow: "hidden",
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  meta: { color: colors.textTertiary, fontSize: 12 },
  description: { color: colors.textSecondary, fontSize: 14 },
  steps: { marginTop: spacing.xs, gap: spacing.xs },
  disclosure: { color: colors.accent, fontSize: 13, fontWeight: "600" },
  nestedSteps: {
    marginLeft: spacing.md,
    borderLeftWidth: 1,
    borderLeftColor: colors.border,
    paddingLeft: spacing.sm,
  },
  stepRow: { gap: 2 },
  stepText: { color: colors.textSecondary, fontSize: 13 },
});
