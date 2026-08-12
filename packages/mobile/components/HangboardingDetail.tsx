import { formatDateTime, formatDurationSeconds } from "@dofek/format/format";
import type { HangboardingDetail as HangboardingDetailData } from "@dofek/providers/hangboarding";
import { StyleSheet, Text, View } from "react-native";
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

function intervalTypeLabel(value: "work" | "rest" | null): string {
  if (value == null) return "—";
  return value === "work" ? "Work" : "Rest";
}

export function HangboardingDetail({ data, loading, error }: HangboardingDetailProps) {
  if (data == null && loading) {
    return <QueryStatePanel variant="loading" minHeight={220} />;
  }

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
        <Metadata label="Session" value={nullableValue(data.sessionId)} />
        <Metadata label="Board" value={nullableValue(data.boardName)} />
        <Metadata label="Board ID" value={nullableValue(data.boardId)} />
      </View>

      {data.intervals.length === 0 ? (
        <QueryStatePanel variant="empty" message="No interval data available." minHeight={120} />
      ) : (
        <View style={styles.intervalList} accessibilityLabel="Hangboarding intervals">
          {data.intervals.map((interval) => (
            <View key={interval.id} style={styles.intervalRow}>
              <View style={styles.intervalHeader}>
                <Text style={styles.intervalLabel} testID="hangboarding-interval-label">
                  {nullableValue(interval.label)}
                </Text>
                <Text style={styles.intervalType}>{intervalTypeLabel(interval.intervalType)}</Text>
              </View>
              <View style={styles.intervalMetadata}>
                <Text style={styles.intervalTimestamp}>{formatDateTime(interval.startedAt)}</Text>
                <Text style={styles.intervalTimestamp}>
                  {interval.endedAt == null ? "—" : formatDateTime(interval.endedAt)}
                </Text>
                <Text style={styles.intervalDuration}>
                  {interval.durationSeconds == null
                    ? "—"
                    : formatDurationSeconds(interval.durationSeconds)}
                </Text>
              </View>
            </View>
          ))}
        </View>
      )}
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
  metadataItem: { gap: spacing.xs, minWidth: "46%", flexGrow: 1 },
  metadataLabel: {
    color: colors.textTertiary,
    fontSize: 11,
    letterSpacing: 0.3,
    textTransform: "uppercase",
  },
  metadataValue: { color: colors.text, fontSize: 14 },
  intervalList: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    overflow: "hidden",
  },
  intervalRow: {
    borderBottomColor: colors.surfaceSecondary,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: spacing.sm,
    padding: spacing.md,
  },
  intervalHeader: { flexDirection: "row", gap: spacing.sm, justifyContent: "space-between" },
  intervalLabel: { color: colors.text, flex: 1, fontSize: 14, fontWeight: "600" },
  intervalType: { color: colors.textSecondary, fontSize: 12, textTransform: "uppercase" },
  intervalMetadata: { flexDirection: "row", gap: spacing.sm, justifyContent: "space-between" },
  intervalTimestamp: { color: colors.textTertiary, flex: 1, fontSize: 11 },
  intervalDuration: {
    color: colors.text,
    fontSize: 13,
    fontVariant: ["tabular-nums"],
    fontWeight: "600",
  },
});
