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
import { getQueryErrorMessage, QueryStatePanel } from "./QueryStatePanel";

type PlannedWorkoutDay = AppRouterOutputs["calendar"]["upcomingWorkouts"][number];
type PlannedWorkoutStep = PlannedWorkoutDay["workouts"][number]["steps"][number];

interface UpcomingWorkoutsProps {
  days: readonly PlannedWorkoutDay[] | undefined;
  isLoading?: boolean;
  isError?: boolean;
  error?: unknown;
  onRetry?: () => void;
  retrying?: boolean;
}

type UnitConverter = ReturnType<typeof useUnitConverter>;

/** Provider-reported schedule only; completed totals stay owned by the activity queries. */
export function UpcomingWorkouts({
  days,
  isLoading = false,
  isError = false,
  error,
  onRetry,
  retrying = false,
}: UpcomingWorkoutsProps) {
  const units = useUnitConverter();
  const populatedDays = days?.filter((day) => day.workouts.length > 0) ?? [];
  const hasWorkouts = populatedDays.length > 0;
  if (!hasWorkouts && !isLoading && !isError) return null;

  return (
    <View style={styles.section} accessibilityLabel="Upcoming workouts">
      <Text accessibilityRole="header" style={styles.heading}>
        Upcoming workouts
      </Text>
      {!hasWorkouts && isLoading && !isError ? (
        <QueryStatePanel variant="loading" minHeight={44} />
      ) : !hasWorkouts && isError ? (
        <QueryStatePanel
          variant="error"
          title="Upcoming workouts: Could not load this section"
          message={getQueryErrorMessage(error)}
          minHeight={60}
          onRetry={onRetry}
          retrying={retrying}
        />
      ) : (
        <View style={styles.days}>
          {populatedDays.map((day) => (
            <View key={day.date} style={styles.day}>
              <Text style={styles.dayHeading}>
                {formatDateMedium(day.date, { timeZone: "UTC" })}
              </Text>
              {day.workouts.map((workout) => {
                const sportLabel = workout.sportType
                  ? formatActivityTypeLabel(workout.sportType)
                  : null;
                const sportIsTitle = workout.title == null && sportLabel != null;
                return (
                  <View key={`${workout.providerId}:${workout.id}`} style={styles.card}>
                    <View style={styles.titleRow}>
                      <Text style={styles.title}>
                        {workout.title ?? sportLabel ?? "Planned workout"}
                      </Text>
                      <Text style={styles.plannedPill}>Planned</Text>
                    </View>
                    <Text style={styles.meta}>
                      {workout.startTime ? `${workout.startTime} · ` : ""}
                      {!sportIsTitle && sportLabel ? `${sportLabel} · ` : ""}
                      {providerSourceLabel(workout.providerId)}
                    </Text>
                    {workout.description ? (
                      <Text style={styles.description}>{workout.description}</Text>
                    ) : null}
                    {workout.steps.length > 0 ? (
                      <WorkoutSteps steps={workout.steps} units={units} />
                    ) : null}
                  </View>
                );
              })}
            </View>
          ))}
          {isError ? (
            <QueryStatePanel
              variant="error"
              title="Upcoming workouts: Could not load this section"
              message={getQueryErrorMessage(error)}
              minHeight={60}
              onRetry={onRetry}
              retrying={retrying}
            />
          ) : null}
        </View>
      )}
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
            step.durationSeconds != null ? formatDurationSeconds(step.durationSeconds) : null,
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
  section: { gap: spacing.sm, marginBottom: spacing.md },
  heading: {
    color: colors.textSecondary,
    fontSize: 13,
    fontWeight: "600",
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  days: { gap: spacing.md },
  day: { gap: spacing.sm },
  dayHeading: { color: colors.text, fontSize: 15, fontWeight: "600" },
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
