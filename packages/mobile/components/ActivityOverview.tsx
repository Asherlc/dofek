import {
  type ActivityDataState,
  type ActivityMetric,
  activityDataStateLabel,
  formatActivityMetric,
} from "@dofek/format/activity-data-state";
import {
  type ActivityOverviewComparison,
  type ActivityOverviewKey,
  activityOverviewChangeForKey,
  formatActivityOverviewChange,
} from "@dofek/format/activity-overview";
import { formatDurationMinutes } from "@dofek/format/format";
import { formatMeasurementText, type UnitConverter } from "@dofek/format/units";
import { StyleSheet, Text, View } from "react-native";
import { colors, radius, spacing } from "../theme";

export interface ActivityOverviewData {
  activityCount: number;
  totalMinutes: number;
  totalDistanceMeters: number | null;
  totalDistanceState: ActivityDataState;
  totalElevationGainM: number | null;
  totalElevationState: ActivityDataState;
  comparison?: ActivityOverviewComparison;
}

type ActivityOverviewItem =
  | { key: "activityCount"; label: string; value: string }
  | { key: "totalMinutes"; label: string; value: string }
  | (ActivityMetric & { key: "totalDistanceMeters" })
  | (ActivityMetric & { key: "totalElevationGainM" });

export function ActivityOverview({
  overview,
  units,
}: {
  overview: ActivityOverviewData | undefined;
  units: UnitConverter;
}) {
  const items: ActivityOverviewItem[] = overview
    ? [
        { key: "activityCount", label: "Activities", value: String(overview.activityCount) },
        { key: "totalMinutes", label: "Time", value: formatDurationMinutes(overview.totalMinutes) },
        {
          key: "totalDistanceMeters",
          ...formatActivityMetric(
            "Distance",
            overview.totalDistanceMeters,
            overview.totalDistanceState,
            (distanceMeters) => formatMeasurementText(units.formatDistance(distanceMeters / 1000)),
          ),
        },
        {
          key: "totalElevationGainM",
          ...formatActivityMetric(
            "Elevation",
            overview.totalElevationGainM,
            overview.totalElevationState,
            (elevationMeters) => formatMeasurementText(units.formatElevation(elevationMeters)),
          ),
        },
      ]
    : [
        { key: "activityCount", label: "Activities", value: "Loading…" },
        { key: "totalMinutes", label: "Time", value: "Loading…" },
        { key: "totalDistanceMeters", status: "missing", label: "Distance", reason: "Loading…" },
        {
          key: "totalElevationGainM",
          status: "missing",
          label: "Elevation",
          reason: "Loading…",
        },
      ];

  const formatComparisonMagnitude: Record<ActivityOverviewKey, (value: number) => string> = {
    activityCount: (value) => String(value),
    totalMinutes: (value) => formatDurationMinutes(value),
    totalDistanceMeters: (value) => formatMeasurementText(units.formatDistance(value / 1000)),
    totalElevationGainM: (value) => formatMeasurementText(units.formatElevation(value)),
  };

  return (
    <View style={styles.overviewGrid}>
      {items.map((item) => {
        const isMetric = "status" in item;
        const comparison = overview?.comparison
          ? activityOverviewChangeForKey(overview.comparison, item.key)
          : undefined;
        const comparisonText = comparison
          ? formatActivityOverviewChange(
              comparison,
              overview?.comparison?.periodLabel ?? "previous period",
              formatComparisonMagnitude[item.key],
            )
          : undefined;
        const currentAccessibilityLabel = isMetric
          ? item.status === "available"
            ? `${item.label} ${item.value}`
            : `${item.label} ${activityDataStateLabel(item.status)}: ${item.reason}`
          : `${item.label} ${item.value}`;

        return (
          <View
            key={item.key}
            style={styles.overviewItem}
            accessible={isMetric || comparisonText !== undefined}
            accessibilityLabel={
              [currentAccessibilityLabel, comparisonText].filter(Boolean).join(". ") || undefined
            }
          >
            <Text style={styles.overviewValue}>
              {isMetric && item.status !== "available"
                ? `${item.label} ${activityDataStateLabel(item.status)}`
                : item.value}
            </Text>
            <Text style={styles.overviewLabel}>
              {isMetric && item.status !== "available" ? item.reason : item.label}
            </Text>
            {comparisonText ? <Text style={styles.activityMeta}>{comparisonText}</Text> : null}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  overviewGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
  },
  overviewItem: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    flexBasis: "47%",
    flexGrow: 1,
    padding: spacing.md,
  },
  overviewValue: {
    color: colors.text,
    fontSize: 20,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  overviewLabel: {
    color: colors.textSecondary,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.5,
    marginTop: 2,
    textTransform: "uppercase",
  },
  activityMeta: {
    color: colors.textSecondary,
    fontSize: 12,
    marginTop: 2,
  },
});
