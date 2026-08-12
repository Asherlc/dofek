import { formatDateTime, formatDurationSeconds, formatNumber } from "@dofek/format/format";
import type { HangboardingSummary as HangboardingSummaryData } from "@dofek/providers/hangboarding";
import { StyleSheet, Text, View } from "react-native";
import { colors, spacing } from "../theme";
import { SparkLine } from "./charts/SparkLine";
import { QueryStatePanel } from "./QueryStatePanel";

interface HangboardingSummaryProps {
  data: HangboardingSummaryData | undefined;
  loading: boolean;
}

function formatNullableDuration(value: number | null): string {
  return value == null ? "—" : formatDurationSeconds(value);
}

function formatNullableHeartRate(value: number | null): string {
  return value == null ? "—" : `${formatNumber(value, 0)} bpm`;
}

export function HangboardingSummary({ data, loading }: HangboardingSummaryProps) {
  if (data == null && loading) {
    return <QueryStatePanel variant="loading" minHeight={220} />;
  }

  if (data == null || data.sessionCount === 0) {
    return (
      <QueryStatePanel variant="empty" message="No Hangboarding sessions yet." minHeight={220} />
    );
  }

  const metrics = [
    { label: "Sessions", value: String(data.sessionCount) },
    { label: "Total Time", value: formatDurationSeconds(data.totalDurationSeconds) },
    { label: "Avg Session", value: formatNullableDuration(data.averageDurationSeconds) },
    { label: "Work Time", value: formatNullableDuration(data.totalWorkDurationSeconds) },
    { label: "Rest Time", value: formatNullableDuration(data.totalRestDurationSeconds) },
    {
      label: "Work Intervals",
      value: data.workIntervalCount == null ? "—" : String(data.workIntervalCount),
    },
    { label: "Avg Heart Rate", value: formatNullableHeartRate(data.averageHeartRate) },
    { label: "Peak Heart Rate", value: formatNullableHeartRate(data.peakHeartRate) },
  ];

  return (
    <View style={styles.container}>
      <View style={styles.grid}>
        {metrics.map((metric) => (
          <View key={metric.label} style={styles.metricCard}>
            <Text style={styles.metricLabel}>{metric.label}</Text>
            <Text style={styles.metricValue}>{metric.value}</Text>
          </View>
        ))}
      </View>

      <View style={styles.trendCard}>
        <Text style={styles.sectionLabel}>Daily Duration</Text>
        {data.daily.length > 0 ? (
          <SparkLine
            data={data.daily.map((row) => row.durationSeconds)}
            color={colors.blue}
            height={48}
          />
        ) : (
          <Text style={styles.emptyText}>No daily Hangboarding duration</Text>
        )}
      </View>

      {data.latestSession ? (
        <View style={styles.latestCard}>
          <Text style={styles.sectionLabel}>Latest Session</Text>
          <Text style={styles.latestTitle}>
            {data.latestSession.planName ?? "Hangboarding session"}
          </Text>
          {data.latestSession.boardName ? (
            <Text style={styles.latestBoard}>{data.latestSession.boardName}</Text>
          ) : null}
          <View style={styles.latestMetadata}>
            <View style={styles.latestMetadataItem}>
              <Text style={styles.metadataLabel}>Started</Text>
              <Text style={styles.metadataValue}>
                {formatDateTime(data.latestSession.startedAt)}
              </Text>
            </View>
            <View style={styles.latestMetadataItem}>
              <Text style={styles.metadataLabel}>Duration</Text>
              <Text style={styles.metadataValue}>
                {formatDurationSeconds(data.latestSession.durationSeconds)}
              </Text>
            </View>
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: spacing.md },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  metricCard: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    flexGrow: 1,
    gap: spacing.xs,
    minWidth: "46%",
    padding: spacing.md,
  },
  metricLabel: {
    color: colors.textTertiary,
    fontSize: 11,
    letterSpacing: 0.3,
    textTransform: "uppercase",
  },
  metricValue: {
    color: colors.text,
    fontSize: 18,
    fontVariant: ["tabular-nums"],
    fontWeight: "700",
  },
  trendCard: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    gap: spacing.sm,
    padding: spacing.md,
  },
  sectionLabel: {
    color: colors.textTertiary,
    fontSize: 11,
    letterSpacing: 0.3,
    textTransform: "uppercase",
  },
  emptyText: { color: colors.textSecondary, fontSize: 13 },
  latestCard: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    gap: spacing.sm,
    padding: spacing.md,
  },
  latestTitle: { color: colors.text, fontSize: 15, fontWeight: "600" },
  latestBoard: { color: colors.textSecondary, fontSize: 13 },
  latestMetadata: { flexDirection: "row", gap: spacing.lg },
  latestMetadataItem: { flex: 1, gap: spacing.xs },
  metadataLabel: { color: colors.textTertiary, fontSize: 12 },
  metadataValue: { color: colors.text, fontSize: 13 },
});
