import {
  bannerHeading,
  DATA_READINESS_ERROR_MESSAGE,
  dataReadinessMessage,
  freshnessLabel,
} from "@dofek/providers/data-readiness-banner";
import { statusColors, textColors } from "@dofek/scoring/colors";
import { StyleSheet, Text, View } from "react-native";
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
        <Text style={[styles.heading, styles.lightText]}>Data readiness is unavailable</Text>
        <Text style={[styles.datasetMessage, styles.lightText]}>
          {DATA_READINESS_ERROR_MESSAGE}
        </Text>
      </View>
    );
  }

  if (!data || data.overallStatus === "healthy") return null;

  const isDarkBanner =
    data.overallStatus === "syncing" ||
    data.overallStatus === "stale" ||
    data.overallStatus === "blocked";
  const relevantDatasets = data.datasets.filter((dataset) => dataset.status !== "healthy");
  const checkedAt = freshnessLabel(data);

  return (
    <View style={[styles.banner, stylesByStatus[data.overallStatus]]}>
      <Text style={[styles.heading, isDarkBanner && styles.lightText]}>{bannerHeading(data)}</Text>
      {checkedAt ? (
        <Text style={[styles.freshness, isDarkBanner && styles.lightText]}>{checkedAt}</Text>
      ) : null}
      {relevantDatasets.map((dataset) => {
        const isDatasetDark =
          dataset.status === "syncing" ||
          dataset.status === "stale" ||
          dataset.status === "blocked";
        return (
          <View key={dataset.key} style={styles.dataset}>
            <Text style={[styles.datasetLabel, isDatasetDark && styles.lightText]}>
              {dataset.label}
            </Text>
            <Text style={[styles.datasetMessage, isDatasetDark && styles.lightText]}>
              {dataReadinessMessage(dataset)}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    borderRadius: radius.lg,
    borderWidth: 1,
    padding: spacing.md,
    gap: spacing.sm,
  },
  heading: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "700",
  },
  freshness: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "600",
  },
  dataset: {
    borderRadius: radius.md,
    backgroundColor: "rgba(255, 255, 255, 0.06)",
    padding: spacing.sm,
    gap: spacing.xs,
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
  lightText: {
    color: "#ffffff",
  },
});

const stylesByStatus = StyleSheet.create({
  syncing: {
    backgroundColor: "#0f2742",
    borderColor: statusColors.info,
  },
  stale: {
    backgroundColor: "#31240d",
    borderColor: statusColors.warning,
  },
  missing: {
    backgroundColor: colors.surfaceSecondary,
    borderColor: textColors.tertiary,
  },
  blocked: {
    backgroundColor: "#3b1212",
    borderColor: statusColors.danger,
  },
});
