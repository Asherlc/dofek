import { formatDateMedium } from "@dofek/format/format";
import { formatMeasurementText, type UnitConverter } from "@dofek/format/units";
import type { ProgressiveOverloadRow } from "dofek-server/types";
import { StyleSheet, Text, View } from "react-native";
import { colors } from "../theme";
import { SparkLine } from "./charts/SparkLine";

interface ProgressiveOverloadCardsProps {
  exercises: ProgressiveOverloadRow[];
  loading?: boolean;
  units: UnitConverter;
}

function trendLabel(trend: ProgressiveOverloadRow["trend"]): string {
  if (trend === "increasing") return "Increasing";
  if (trend === "decreasing") return "Decreasing";
  return "Stable";
}

function rateLabel(exercise: ProgressiveOverloadRow, units: UnitConverter): string {
  return `${trendLabel(exercise.trend)} ${formatMeasurementText(
    units.formatWeight(Math.abs(exercise.slopeKgPerWeek)),
  )}/week`;
}

function intervalLabel(exercise: ProgressiveOverloadRow, units: UnitConverter): string | null {
  if (exercise.uncertainty.availability === "unavailable") return null;
  const lower = units.convertWeight(exercise.uncertainty.lowerKgPerWeek).toFixed(1);
  const upper = units.convertWeight(exercise.uncertainty.upperKgPerWeek).toFixed(1);
  const unit = units.formatWeight(0).parts.find((part) => part.type === "unit")?.value;
  return `${exercise.uncertainty.methodLabel}: ${lower} to ${upper} ${unit ?? units.weightLabel}/week`;
}

function periodLabel(exercise: ProgressiveOverloadRow): string {
  return `${formatDateMedium(exercise.period.startWeek)} – ${formatDateMedium(
    exercise.period.endWeek,
  )}`;
}

function countLabel(exercise: ProgressiveOverloadRow): string {
  return `${exercise.period.observationCount} recorded weeks across ${exercise.period.elapsedWeekCount} calendar weeks`;
}

function accessibilityLabel(exercise: ProgressiveOverloadRow, units: UnitConverter): string {
  const interval = intervalLabel(exercise, units);
  return `${[
    exercise.exerciseName,
    rateLabel(exercise, units),
    `${formatDateMedium(exercise.period.startWeek)} to ${formatDateMedium(exercise.period.endWeek)}`,
    countLabel(exercise),
    interval,
    exercise.uncertainty.statement,
    exercise.interpretation,
    exercise.deloadContext,
  ]
    .filter((part): part is string => part !== null)
    .map((part) => part.replace(/\.$/, ""))
    .join(". ")}.`;
}

export function ProgressiveOverloadCards({
  exercises,
  loading = false,
  units,
}: ProgressiveOverloadCardsProps) {
  return (
    <View style={styles.section}>
      <Text style={styles.title}>Exercise Volume Trends</Text>
      {loading ? <Text style={styles.empty}>Loading exercise volume trends</Text> : null}
      {!loading && exercises.length === 0 ? (
        <Text style={styles.empty}>No exercise volume trends in this period</Text>
      ) : null}
      {!loading
        ? exercises.map((exercise) => {
            const interval = intervalLabel(exercise, units);
            return (
              <View
                key={exercise.exerciseName}
                accessible
                accessibilityLabel={accessibilityLabel(exercise, units)}
                style={styles.card}
              >
                <Text style={styles.exercise}>{exercise.exerciseName}</Text>
                <Text style={styles.detail}>{rateLabel(exercise, units)}</Text>
                <Text style={styles.detail}>{periodLabel(exercise)}</Text>
                <Text style={styles.detail}>{countLabel(exercise)}</Text>
                {interval ? <Text style={styles.detail}>{interval}</Text> : null}
                <Text style={styles.detail}>{exercise.uncertainty.statement}</Text>
                <Text style={styles.detail}>{exercise.interpretation}</Text>
                <Text style={styles.detail}>{exercise.deloadContext}</Text>
                <SparkLine
                  data={exercise.observations.map((observation) => observation.totalVolumeKg)}
                  color={colors.accent}
                  height={40}
                />
              </View>
            );
          })
        : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: 12 },
  title: { color: colors.text, fontSize: 16, fontWeight: "700" },
  card: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    gap: 6,
    padding: 16,
  },
  exercise: { color: colors.text, fontSize: 15, fontWeight: "600" },
  detail: { color: colors.textSecondary, fontSize: 12, lineHeight: 18 },
  empty: { color: colors.textSecondary, fontSize: 13 },
});
