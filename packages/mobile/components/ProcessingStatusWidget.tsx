import { formatRelativeTime } from "@dofek/format/format";
import {
  type ProcessingDisplayStage,
  type ProcessingDisplayStatus,
  processingAggregateProgress,
  processingDatasetStatusLabel,
  processingFailureGroups,
  processingHeading,
  processingStatusMessage,
  processingTarget,
} from "@dofek/providers/processing-status";
import { useRouter } from "expo-router";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { trpc } from "../lib/trpc";
import { colors, spacing } from "../theme";
import { RecomputeStatusIndicator } from "./RecomputeStatusIndicator";
import { SourceProcessingStatusCard } from "./SourceProcessingStatusCard";

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
    lastFailedAt: string | null;
  }>;
  operations: Array<{
    id: string;
    providerId: string | null;
    kind: string;
    createdAt: string;
    status: ProcessingDisplayStatus;
    datasets: string[];
    dismissed: boolean;
    errorMessage: string | null;
    errorCode?: string | null;
    timeline: Array<{
      sequence: number;
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
  const router = useRouter();
  const trpcUtils = trpc.useUtils();
  const dismissMutation = trpc.processing.dismiss.useMutation({
    onSuccess: async () => {
      await trpcUtils.processing.status.invalidate();
      await trpcUtils.processing.alerts.invalidate();
    },
  });

  if (loading && !data) return null;
  if (error && !data) {
    return (
      <SourceProcessingStatusCard
        heading="Processing status is unavailable"
        message={error.message}
        progress={null}
        status="failed"
      />
    );
  }
  if (!data || (data.overallStatus === "ready" && !alwaysVisible)) {
    return null;
  }

  const progress = processingAggregateProgress(data.datasets);
  const target = processingTarget({
    providerId: data.scope.providerId,
    datasets: data.datasets,
    operationKind: data.operations[0]?.kind,
  });
  const problemDatasets = data.datasets.filter(
    (dataset) => dataset.status === "failed" || dataset.status === "blocked",
  );
  const failureGroups = processingFailureGroups({
    datasets: data.datasets,
    operations: data.operations,
  });
  const statusMessage =
    failureGroups.length > 0
      ? null
      : processingStatusMessage({
          status: data.overallStatus,
          errorMessage: null,
        });
  const hasFailureStatus = data.overallStatus === "failed" || data.overallStatus === "blocked";
  const inProgressDatasets = data.datasets.filter((dataset) =>
    ["active", "partial", "waiting", "delayed"].includes(dataset.status),
  );
  if (hasFailureStatus && failureGroups.length === 0 && inProgressDatasets.length === 0) {
    return null;
  }
  const displayStatus =
    hasFailureStatus && failureGroups.length === 0
      ? (inProgressDatasets[0]?.status ?? data.overallStatus)
      : data.overallStatus;
  const heading = processingHeading(displayStatus, target);
  const datasetsWithHistory = data.datasets.filter(
    (dataset) =>
      dataset.status !== "ready" || dataset.lastAdvancedAt !== null || dataset.lastReadyAt !== null,
  );
  const visibleDatasets = alwaysVisible
    ? datasetsWithHistory
    : failureGroups.length > 0
      ? problemDatasets
      : inProgressDatasets;
  const historicalDatasetDetails =
    visibleDatasets.length > 0 ? (
      <View style={styles.datasetList}>
        {visibleDatasets.map((dataset) => {
          const lastReady = dataset.lastReadyAt ? formatRelativeTime(dataset.lastReadyAt) : null;
          return (
            <View key={dataset.key} style={styles.datasetRow}>
              <View style={styles.datasetHeading}>
                <Text style={styles.datasetLabel}>{dataset.label}</Text>
                <Text style={styles.datasetStatus}>
                  {processingDatasetStatusLabel(dataset.status)}
                </Text>
              </View>
              <Text style={styles.datasetFreshness}>
                {lastReady ? `Last ready: ${lastReady}` : "No completed update recorded"}
              </Text>
            </View>
          );
        })}
      </View>
    ) : null;
  const failureGroupDetails =
    failureGroups.length > 0 ? (
      <View style={styles.datasetList}>
        {failureGroups.map((group) => {
          const failedAt = group.failedAt ? formatRelativeTime(group.failedAt) : null;
          const lastReadyAt = group.lastReadyAt ? formatRelativeTime(group.lastReadyAt) : null;
          const labelPrefix = group.providerLabel ? `${group.providerLabel} sync` : "data update";
          return (
            <View key={group.operationId} style={styles.datasetRow}>
              <View style={styles.failureGroupHeader}>
                <View style={styles.failureGroupCopy}>
                  <View style={styles.datasetLabels}>
                    {group.datasetLabels.map((label) => (
                      <Text key={label} style={styles.datasetLabel}>
                        {label}
                      </Text>
                    ))}
                  </View>
                  <Text style={styles.datasetFreshness}>
                    {processingDatasetStatusLabel(group.status)}: {failedAt ?? "not recorded"}
                  </Text>
                  {lastReadyAt ? (
                    <Text style={styles.datasetFreshness}>
                      Last successful update: {lastReadyAt}
                    </Text>
                  ) : null}
                  {group.errorMessage ? (
                    <Text style={styles.datasetError}>{group.errorMessage}</Text>
                  ) : null}
                </View>
                <View style={styles.failureActions}>
                  {group.requiresReconnect && group.providerId && group.providerLabel ? (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Reconnect ${group.providerLabel}`}
                      onPress={() => router.push(`/providers/${group.providerId}`)}
                      style={styles.reconnectButton}
                    >
                      <Text style={styles.reconnectButtonText}>
                        Reconnect {group.providerLabel}
                      </Text>
                    </Pressable>
                  ) : null}
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Dismiss ${labelPrefix} failure`}
                    accessibilityState={{ disabled: dismissMutation.isPending }}
                    disabled={dismissMutation.isPending}
                    onPress={() => dismissMutation.mutate({ operationId: group.operationId })}
                    style={[
                      styles.dismissButton,
                      dismissMutation.isPending && styles.actionDisabled,
                    ]}
                  >
                    <Text style={styles.dismissButtonText}>Dismiss</Text>
                  </Pressable>
                </View>
              </View>
            </View>
          );
        })}
      </View>
    ) : null;
  const datasetDetails = failureGroupDetails ?? historicalDatasetDetails;

  if (target.action === "recompute" && failureGroups.length === 0) {
    return <RecomputeStatusIndicator label={heading} progress={progress} status={displayStatus} />;
  }

  return (
    <SourceProcessingStatusCard
      contextLabel={contextLabel}
      heading={heading}
      message={statusMessage}
      progress={progress}
      status={displayStatus}
    >
      {datasetDetails}
      {dismissMutation.error ? (
        <Text style={styles.datasetError} accessibilityRole="alert">
          {dismissMutation.error.message}
        </Text>
      ) : null}
    </SourceProcessingStatusCard>
  );
}

const styles = StyleSheet.create({
  datasetList: {
    borderTopColor: colors.surfaceSecondary,
    borderTopWidth: StyleSheet.hairlineWidth,
    marginTop: spacing.xs,
  },
  datasetRow: {
    borderBottomColor: colors.surfaceSecondary,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 2,
    paddingVertical: spacing.sm,
  },
  datasetHeading: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
    justifyContent: "space-between",
  },
  datasetLabel: { color: colors.text, fontSize: 12, fontWeight: "700" },
  datasetLabels: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs },
  datasetStatus: { color: colors.textSecondary, fontSize: 12 },
  datasetFreshness: { color: colors.textTertiary, fontSize: 12 },
  datasetError: { color: colors.danger, fontSize: 12, lineHeight: 17, marginTop: 2 },
  failureGroupHeader: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: spacing.sm,
    justifyContent: "space-between",
  },
  failureGroupCopy: { flex: 1, gap: 2 },
  failureActions: { gap: spacing.xs },
  reconnectButton: {
    alignItems: "center",
    backgroundColor: colors.accent,
    borderRadius: 6,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  reconnectButtonText: { color: "#ffffff", fontSize: 12, fontWeight: "700" },
  dismissButton: {
    alignItems: "center",
    borderColor: colors.surfaceSecondary,
    borderRadius: 6,
    borderWidth: 1,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  dismissButtonText: { color: colors.text, fontSize: 12, fontWeight: "700" },
  actionDisabled: { opacity: 0.5 },
});
