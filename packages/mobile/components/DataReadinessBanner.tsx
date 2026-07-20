import { bannerHeading, freshnessLabel } from "@dofek/providers/data-readiness-banner";
import { statusColors, textColors } from "@dofek/scoring/colors";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { colors, radius, spacing } from "../theme";

export type DataReadinessStatus = "healthy" | "syncing" | "stale" | "missing" | "blocked";

export interface DataReadinessDataset {
  key: "dailyMetrics" | "sleep" | "activity";
  label: string;
  rawRows: number;
  latestRawAt: string | null;
  latestReadModelAt: string | null;
  cdcLagSeconds: number | null;
  readModelLagSeconds: number | null;
  status: DataReadinessStatus;
  message: string;
}

export interface DataReadinessSnapshot {
  overallStatus: DataReadinessStatus;
  generatedAt: string;
  syncingProviders?: Array<{ id: string; name: string }>;
  datasets: DataReadinessDataset[];
}

const indicatorColorByStatus: Record<Exclude<DataReadinessStatus, "healthy">, string> = {
  syncing: statusColors.info,
  stale: statusColors.warning,
  missing: textColors.tertiary,
  blocked: statusColors.danger,
};

interface DataReadinessBannerProps {
  data?: DataReadinessSnapshot;
  error?: { message?: string } | null;
  loading?: boolean;
}

export function DataReadinessBanner({
  data,
  error = null,
  loading = false,
}: DataReadinessBannerProps) {
  if (loading) return null;

  if (error) {
    return (
      <View style={[styles.banner, stylesByStatus.blocked]}>
        <Text style={styles.heading}>Data readiness is unavailable</Text>
        <Text style={styles.datasetMessage}>
          {error.message ?? "The data readiness check failed."}
        </Text>
      </View>
    );
  }

  if (!data || data.overallStatus === "healthy") return null;

  const relevantDatasets = data.datasets.filter((dataset) => dataset.status !== "healthy");
  const checkedAt = freshnessLabel(data);
  const status = data.overallStatus;

  return (
    <View style={[styles.banner, stylesByStatus[status]]}>
      <View style={styles.header}>
        {status === "syncing" ? (
          <ActivityIndicator color={indicatorColorByStatus[status]} size="small" />
        ) : (
          <View style={[styles.statusDot, { backgroundColor: indicatorColorByStatus[status] }]} />
        )}
        <View style={styles.headingContent}>
          <Text style={styles.heading}>{bannerHeading(data)}</Text>
          {checkedAt ? <Text style={styles.freshness}>{checkedAt}</Text> : null}
        </View>
      </View>
      {relevantDatasets.map((dataset) => (
        <View key={dataset.key} style={styles.dataset}>
          <Text style={styles.datasetLabel}>{dataset.label}</Text>
          <Text style={styles.datasetMessage}>{dataset.message}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    borderRadius: radius.lg,
    borderWidth: 1,
    borderLeftWidth: 4,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    gap: spacing.sm,
  },
  header: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
  },
  headingContent: {
    flex: 1,
  },
  heading: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "700",
    lineHeight: 18,
  },
  freshness: {
    color: colors.textSecondary,
    fontSize: 12,
    lineHeight: 16,
  },
  statusDot: {
    borderRadius: radius.full,
    height: 8,
    marginHorizontal: spacing.xs,
    width: 8,
  },
  dataset: {
    borderRadius: radius.md,
    backgroundColor: colors.surfaceSecondary,
    borderColor: "rgba(255, 255, 255, 0.08)",
    borderWidth: 1,
    padding: spacing.sm,
    gap: 2,
  },
  datasetLabel: {
    color: colors.text,
    fontSize: 12,
    fontWeight: "700",
    textTransform: "uppercase",
  },
  datasetMessage: {
    color: colors.textSecondary,
    fontSize: 13,
    lineHeight: 18,
  },
});

const stylesByStatus = StyleSheet.create({
  syncing: {
    borderColor: colors.surfaceSecondary,
    borderLeftColor: statusColors.info,
  },
  stale: {
    borderColor: colors.surfaceSecondary,
    borderLeftColor: statusColors.warning,
  },
  missing: {
    borderColor: colors.surfaceSecondary,
    borderLeftColor: textColors.tertiary,
  },
  blocked: {
    borderColor: colors.surfaceSecondary,
    borderLeftColor: statusColors.danger,
  },
});
