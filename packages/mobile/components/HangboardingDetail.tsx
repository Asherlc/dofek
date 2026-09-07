import { formatDurationSeconds } from "@dofek/format/format";
import { StyleSheet, Text, View } from "react-native";
import type { HangboardingDetail as HangboardingDetailData } from "../../server/src/repositories/hangboarding-repository.ts";
import { colors, spacing } from "../theme";
import { getQueryErrorMessage, QueryStatePanel } from "./QueryStatePanel";

interface HangboardingDetailProps {
  data: HangboardingDetailData | undefined;
  loading: boolean;
  error: unknown;
}

function nullableValue(value: string | null): string {
  return value ?? "—";
}

function durationValue(value: number | null): string {
  return value === null ? "—" : formatDurationSeconds(value);
}

export function HangboardingDetail({ data, loading, error }: HangboardingDetailProps) {
  if (data == null && loading) return <QueryStatePanel variant="loading" minHeight={220} />;

  if (data == null && error) {
    return (
      <QueryStatePanel
        variant="error"
        message={getQueryErrorMessage(error, "Unable to load Hangboarding details.")}
        minHeight={220}
      />
    );
  }

  if (data == null) {
    return (
      <QueryStatePanel
        variant="empty"
        message="No Hangboarding details are available."
        minHeight={220}
      />
    );
  }

  return (
    <View style={styles.container}>
      {error ? (
        <QueryStatePanel variant="error" message={getQueryErrorMessage(error)} minHeight={72} />
      ) : null}
      {data.segmentsError ? (
        <View style={styles.warning} accessibilityRole="alert">
          <Text style={styles.warningText}>
            Some Hangboarding intervals could not be imported: {data.segmentsError} Re-import the
            activity to try again.
          </Text>
        </View>
      ) : null}

      <View style={styles.metadataGrid}>
        <Metadata label="Plan" value={nullableValue(data.planName)} />
        <Metadata label="Board" value={nullableValue(data.boardName)} />
      </View>

      {data.summary.exercises.length > 0 ? (
        <View style={styles.exerciseList} accessibilityLabel="Finger loading summary">
          {data.summary.exercises.map((exercise) => (
            <View key={exercise.label} style={styles.exerciseRow}>
              <Text style={styles.exerciseLabel}>{exercise.label}</Text>
              <Text style={styles.exerciseValue}>
                {exercise.workIntervalCount} {exercise.workIntervalCount === 1 ? "hang" : "hangs"} ·{" "}
                {durationValue(exercise.workDurationSeconds)}
              </Text>
            </View>
          ))}
        </View>
      ) : (
        <QueryStatePanel variant="empty" message="No completed hangs recorded." minHeight={96} />
      )}

      <View style={styles.metricsGrid}>
        <Metadata label="Hangs" value={String(data.summary.workIntervalCount)} />
        <Metadata label="Hang time" value={durationValue(data.summary.totalWorkDurationSeconds)} />
        <Metadata label="Rest time" value={durationValue(data.summary.totalRestDurationSeconds)} />
        <Metadata label="Session time" value={durationValue(data.summary.durationSeconds)} />
      </View>
    </View>
  );
}

function Metadata({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metadataItem}>
      <Text style={styles.metadataLabel}>{label}</Text>
      <Text style={styles.metadataValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: spacing.md },
  warning: {
    backgroundColor: colors.surfaceSecondary,
    borderColor: colors.warning,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.md,
  },
  warningText: { color: colors.warning, fontSize: 13, lineHeight: 18 },
  metadataGrid: { flexDirection: "row", flexWrap: "wrap", gap: spacing.md },
  metricsGrid: { flexDirection: "row", flexWrap: "wrap", gap: spacing.md },
  metadataItem: { gap: spacing.xs, minWidth: "46%", flexGrow: 1 },
  metadataLabel: {
    color: colors.textTertiary,
    fontSize: 11,
    letterSpacing: 0.3,
    textTransform: "uppercase",
  },
  metadataValue: { color: colors.text, fontSize: 14 },
  exerciseList: { backgroundColor: colors.surface, borderRadius: 12, overflow: "hidden" },
  exerciseRow: {
    borderBottomColor: colors.surfaceSecondary,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: spacing.xs,
    padding: spacing.md,
  },
  exerciseLabel: { color: colors.text, fontSize: 16, fontWeight: "600" },
  exerciseValue: { color: colors.textSecondary, fontSize: 14 },
});
