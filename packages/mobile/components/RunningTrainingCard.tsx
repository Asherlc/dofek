import { formatDateMedium, formatNumber, formatPace } from "@dofek/format/format";
import type { UnitConverter } from "@dofek/format/units";
import { runningCadenceLabel } from "@dofek/training/running-cadence";
import {
  RUNNING_DYNAMICS_INVALID_RESPONSE_MESSAGE,
  runningDynamicsResponseV2Schema,
} from "@dofek/training/running-response";
import { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { safeParseData } from "../lib/safe-parse";
import { chartColors, colors, spacing } from "../theme";
import { SparkLine } from "./charts/SparkLine";
import { QueryStatePanel } from "./QueryStatePanel";
import { TrainingChartEmptyState } from "./TrainingChartEmptyState";

export function RunningTrainingCard({
  data: rawData,
  loading,
  error,
  onRetry,
  onOpenActivity,
  units,
}: {
  data: unknown;
  units: UnitConverter;
  loading: boolean;
  error: { message: string } | null;
  onRetry?: () => void;
  onOpenActivity: (id: string) => void;
}) {
  const parsed = useMemo(
    () =>
      rawData === undefined
        ? undefined
        : safeParseData(runningDynamicsResponseV2Schema, rawData, "Running data"),
    [rawData],
  );
  const data = parsed?.data;
  const validationFailed = parsed?.error != null;
  return (
    <View style={styles.card}>
      <Text accessibilityRole="header" style={styles.title}>
        Running
      </Text>
      {error && <QueryStatePanel variant="error" message={error.message} onRetry={onRetry} />}
      {validationFailed && (
        <QueryStatePanel
          variant="error"
          message={RUNNING_DYNAMICS_INVALID_RESPONSE_MESSAGE}
          onRetry={onRetry}
        />
      )}
      {loading && !data && !error && !validationFailed && <QueryStatePanel variant="loading" />}
      {data && (
        <>
          <Text accessibilityRole="header" style={styles.heading}>
            Cadence Trend
          </Text>
          {data.cadenceAvailability.status === "insufficient_data" ? (
            <TrainingChartEmptyState availability={data.cadenceAvailability} />
          ) : (
            <View accessibilityLabel="Running cadence trend, steps per minute">
              <SparkLine
                data={data.data.map((row) => row.cadence)}
                color={chartColors.amber}
                height={100}
                showYAxis
                formatYLabel={(value) => `${formatNumber(value, 0)} spm`}
              />
            </View>
          )}
        </>
      )}
      {data && (
        <Text accessibilityRole="header" style={styles.heading}>
          Running Form
        </Text>
      )}
      {data &&
        (data.availability.status === "insufficient_data" ? (
          <TrainingChartEmptyState availability={data.availability} />
        ) : (
          data.data.map((row) => (
            <Pressable
              key={row.activityId}
              accessibilityRole="button"
              accessibilityLabel={`Open ${row.activityName}`}
              onPress={() => onOpenActivity(row.activityId)}
              style={styles.run}
            >
              <View style={styles.row}>
                <Text style={styles.name}>{row.activityName}</Text>
                <Text style={styles.secondary}>{formatDateMedium(row.date)}</Text>
              </View>
              <View style={styles.row}>
                <Text style={styles.value}>
                  {row.cadence === null ? "Cadence —" : `${formatNumber(row.cadence, 0)} spm`}
                </Text>
                {row.cadence !== null && (
                  <Text style={styles.secondary}>{runningCadenceLabel(row)}</Text>
                )}
              </View>
              <View style={styles.metrics}>
                <Text style={styles.secondary}>
                  Pace{" "}
                  {row.paceSecondsPerKm === null
                    ? "—"
                    : `${formatPace(units.convertPace(row.paceSecondsPerKm))} ${units.paceLabel}`}
                </Text>
                <Text style={styles.secondary}>
                  Distance{" "}
                  {row.distanceKm === null
                    ? "—"
                    : `${formatNumber(units.convertDistance(row.distanceKm))} ${units.distanceLabel}`}
                </Text>
                <Text style={styles.secondary}>
                  Stride{" "}
                  {row.strideLengthMeters === null
                    ? "—"
                    : `${formatNumber(row.strideLengthMeters, 2)} m`}
                </Text>
                <Text style={styles.secondary}>
                  Ground contact{" "}
                  {row.stanceTimeMs === null ? "—" : `${formatNumber(row.stanceTimeMs, 0)} ms`}
                </Text>
                <Text style={styles.secondary}>
                  Vertical oscillation{" "}
                  {row.verticalOscillationMm === null
                    ? "—"
                    : `${formatNumber(row.verticalOscillationMm)} mm`}
                </Text>
              </View>
            </Pressable>
          ))
        ))}
    </View>
  );
}
const styles = StyleSheet.create({
  card: { backgroundColor: colors.surface, borderRadius: 16, padding: 16, gap: spacing.md },
  title: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.textSecondary,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  heading: { fontSize: 14, fontWeight: "600", color: colors.text },
  run: {
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    borderTopColor: colors.surfaceSecondary,
    borderTopWidth: 1,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.sm,
    flexWrap: "wrap",
  },
  name: { fontSize: 14, fontWeight: "600", color: colors.text },
  value: { fontSize: 18, fontWeight: "700", color: colors.text, fontVariant: ["tabular-nums"] },
  secondary: { fontSize: 12, color: colors.textSecondary },
  metrics: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
});
