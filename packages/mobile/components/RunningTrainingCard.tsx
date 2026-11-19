import { formatNumber } from "@dofek/format/format";
import {
  RUNNING_DYNAMICS_INVALID_RESPONSE_MESSAGE,
  runningDynamicsResponseV2Schema,
} from "@dofek/training/running-response";
import { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";
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
}: {
  data: unknown;
  loading: boolean;
  error: { message: string } | null;
  onRetry?: () => void;
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
});
