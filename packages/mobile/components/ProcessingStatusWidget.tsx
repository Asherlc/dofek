import { formatRelativeTime } from "@dofek/format/format";
import {
  type ProcessingDisplayStage,
  type ProcessingDisplayStatus,
  processingAggregateProgress,
  processingDatasetErrorMessage,
  processingDatasetStatusLabel,
  processingHeading,
  processingStatusMessage,
  processingTarget,
} from "@dofek/providers/processing-status";
import { StyleSheet, Text, View } from "react-native";
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
  const statusMessage = processingStatusMessage({
    status: data.overallStatus,
    errorMessage: null,
  });
  const heading = processingHeading(data.overallStatus, target);
  const problemDatasets = data.datasets.filter(
    (dataset) => dataset.status === "failed" || dataset.status === "blocked",
  );
  const datasetsWithHistory = data.datasets.filter(
    (dataset) =>
      dataset.status !== "ready" || dataset.lastAdvancedAt !== null || dataset.lastReadyAt !== null,
  );
  const visibleDatasets = alwaysVisible ? datasetsWithHistory : problemDatasets;
  const datasetDetails =
    visibleDatasets.length > 0 ? (
      <View style={styles.datasetList}>
        {visibleDatasets.map((dataset) => {
          const lastReady = dataset.lastReadyAt ? formatRelativeTime(dataset.lastReadyAt) : null;
          const datasetError =
            dataset.status === "failed" || dataset.status === "blocked"
              ? processingDatasetErrorMessage(data.operations, dataset.key)
              : null;
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
              {datasetError ? <Text style={styles.datasetError}>{datasetError}</Text> : null}
            </View>
          );
        })}
      </View>
    ) : null;

  if (target.action === "recompute" && visibleDatasets.length === 0) {
    return (
      <RecomputeStatusIndicator label={heading} progress={progress} status={data.overallStatus} />
    );
  }

  return (
    <SourceProcessingStatusCard
      contextLabel={contextLabel}
      heading={heading}
      message={statusMessage}
      progress={progress}
      status={data.overallStatus}
    >
      {datasetDetails}
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
  datasetStatus: { color: colors.textSecondary, fontSize: 12 },
  datasetFreshness: { color: colors.textTertiary, fontSize: 12 },
  datasetError: { color: colors.danger, fontSize: 12, lineHeight: 17, marginTop: 2 },
});
