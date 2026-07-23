import {
  type ProcessingDisplayStage,
  type ProcessingDisplayStatus,
  processingAggregateProgress,
  processingCurrentFailure,
  processingHeading,
  processingStatusMessage,
} from "@dofek/providers/processing-status";
import { StyleSheet, Text, View } from "react-native";
import { colors, radius, spacing } from "../theme";

export interface ProcessingStatusSnapshot {
  generatedAt: string;
  scope: { providerId: string | null; datasets: string[] };
  overallStatus: ProcessingDisplayStatus;
  datasets: Array<{
    key: string;
    label: string;
    status: ProcessingDisplayStatus;
    currentStage: ProcessingDisplayStage | null;
    progressPercentage: number | null;
    lastAdvancedAt: string | null;
    lastReadyAt: string | null;
  }>;
  operations: Array<{
    id: string;
    providerId: string | null;
    kind: string;
    createdAt: string;
    status: ProcessingDisplayStatus;
    datasets: string[];
    timeline: Array<{
      stage: ProcessingDisplayStage;
      status: string;
      datasetKey: string | null;
      outputPath: "relational" | "metric_stream" | null;
      occurredAt: string;
      progressPercentage: number | null;
      message: string | null;
      errorCode: string | null;
      errorMessage: string | null;
    }>;
  }>;
}

interface ProcessingStatusWidgetProps {
  data?: ProcessingStatusSnapshot;
  error?: { message: string } | null;
  loading?: boolean;
  contextLabel?: string;
  alwaysVisible?: boolean;
}

export function ProcessingStatusWidget({
  data,
  error = null,
  loading = false,
  contextLabel,
  alwaysVisible = false,
}: ProcessingStatusWidgetProps) {
  if (loading && !data) return null;
  if (error && !data) {
    return (
      <View style={[styles.container, styles.failed]} accessibilityRole="summary">
        <Text style={styles.heading}>Processing status is unavailable</Text>
        <Text style={styles.message}>{error.message}</Text>
      </View>
    );
  }
  if (!data || (data.overallStatus === "ready" && !alwaysVisible)) return null;

  const currentFailure = processingCurrentFailure(data);
  const progress = processingAggregateProgress(data.datasets);

  return (
    <View
      style={[styles.container, borderStyleByStatus[data.overallStatus]]}
      accessibilityRole="summary"
      accessibilityLiveRegion={
        data.overallStatus === "active" || data.overallStatus === "partial" ? "polite" : "none"
      }
    >
      {contextLabel ? <Text style={styles.contextLabel}>{contextLabel}</Text> : null}
      <Text style={styles.heading}>{processingHeading(data.overallStatus)}</Text>
      <Text style={styles.message}>
        {processingStatusMessage({
          status: data.overallStatus,
          errorMessage: currentFailure,
        })}
      </Text>
      {progress !== null && data.overallStatus !== "ready" ? (
        <View
          style={styles.progressTrack}
          testID="processing-status-progress"
          accessibilityRole="progressbar"
          accessibilityLabel="Processing progress"
          accessibilityValue={{ min: 0, max: 100, now: progress }}
        >
          <View style={[styles.progressFill, { width: `${progress}%` }]} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.surface,
    borderColor: colors.surfaceSecondary,
    borderLeftWidth: 4,
    borderRadius: radius.lg,
    borderWidth: 1,
    gap: spacing.xs,
    padding: spacing.sm,
  },
  contextLabel: {
    color: colors.textSecondary,
    fontSize: 11,
    fontWeight: "700",
    textTransform: "uppercase",
  },
  heading: { color: colors.text, fontSize: 14, fontWeight: "700" },
  message: { color: colors.textSecondary, fontSize: 12, lineHeight: 17 },
  progressTrack: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.full,
    height: 6,
    marginTop: spacing.xs,
    overflow: "hidden",
  },
  progressFill: { backgroundColor: colors.accent, height: 6 },
  failed: { borderLeftColor: colors.negative },
});

const borderStyleByStatus = StyleSheet.create({
  ready: { borderLeftColor: colors.positive },
  waiting: { borderLeftColor: colors.accent },
  active: { borderLeftColor: colors.accent },
  partial: { borderLeftColor: colors.accent },
  delayed: { borderLeftColor: colors.warning },
  blocked: { borderLeftColor: colors.negative },
  failed: { borderLeftColor: colors.negative },
  cancelled: { borderLeftColor: colors.textTertiary },
});
