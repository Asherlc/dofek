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
  datasets: DataReadinessDataset[];
}

interface DataReadinessBannerProps {
  data?: DataReadinessSnapshot;
  loading?: boolean;
}

const headingByStatus: Record<Exclude<DataReadinessStatus, "healthy">, string> = {
  syncing: "Data is syncing now",
  stale: "Dashboard summaries are catching up",
  missing: "No data has synced yet",
  blocked: "Data pipeline needs attention",
};

export function DataReadinessBanner({ data, loading = false }: DataReadinessBannerProps) {
  if (loading || !data || data.overallStatus === "healthy") return null;

  const relevantDatasets = data.datasets.filter((dataset) => dataset.status !== "healthy");

  return (
    <View style={[styles.banner, stylesByStatus[data.overallStatus]]}>
      <Text style={styles.heading}>{headingByStatus[data.overallStatus]}</Text>
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
    padding: spacing.md,
    gap: spacing.sm,
  },
  heading: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "700",
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
