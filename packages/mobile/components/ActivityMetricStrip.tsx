import type {
  ActivityDataState,
  ActivityDataStateUnavailableStatus,
} from "@dofek/format/activity-data-state";
import { formatMeasurementText, type UnitConverter } from "@dofek/format/units";
import { StyleSheet, Text, View } from "react-native";
import { colors, radius, spacing } from "../theme";

type ActivityStat =
  | { status: "available"; label: string; value: string }
  | { status: ActivityDataStateUnavailableStatus; label: string; reason: string };

type ActivityLocation = {
  distanceMeters: number | null;
  distanceState: ActivityDataState;
  elevationGainM: number | null;
  elevationState: ActivityDataState;
};

export function ActivityMetricStrip({
  activity,
  units,
}: {
  activity: {
    location: ActivityLocation | null;
    stats: ActivityStat[];
  };
  units: UnitConverter;
}) {
  const stats: ActivityStat[] =
    activity.location != null
      ? [
          formatLocationMetric(
            "Distance",
            activity.location.distanceMeters,
            activity.location.distanceState,
            (value) => formatMeasurementText(units.formatDistance(value / 1000)),
          ),
          formatLocationMetric(
            "Elevation",
            activity.location.elevationGainM,
            activity.location.elevationState,
            (value) => formatMeasurementText(units.formatElevation(value)),
          ),
        ]
      : activity.stats;

  return (
    <View style={styles.statsRow}>
      {stats.slice(0, 2).map((stat) =>
        stat.status === "available" ? (
          <View key={stat.label} style={styles.statBadge}>
            <Text style={styles.statValue}>{stat.value}</Text>
            <Text style={styles.statLabel}>{stat.label}</Text>
          </View>
        ) : (
          <View
            key={stat.label}
            style={styles.statBadge}
            accessibilityLabel={`${stat.label} ${stat.status}`}
          >
            <Text style={styles.statUnavailableTitle}>
              {stat.label} {stat.status === "missing" ? "unavailable" : stat.status}
            </Text>
            <Text style={styles.statUnavailableReason}>{stat.reason}</Text>
          </View>
        ),
      )}
    </View>
  );
}

function formatLocationMetric(
  label: string,
  value: number | null,
  state: ActivityDataState,
  formatValue: (value: number) => string,
): ActivityStat {
  if (state.status === "available" && value != null) {
    return { status: "available", label, value: formatValue(value) };
  }

  return {
    status: state.status === "available" ? "missing" : state.status,
    label,
    reason: state.status === "available" ? `${label} unavailable` : state.reason,
  };
}

const styles = StyleSheet.create({
  statsRow: {
    flexDirection: "row",
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  statBadge: {
    flex: 1,
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.md,
    paddingVertical: spacing.sm,
    alignItems: "center",
  },
  statValue: {
    color: colors.text,
    fontSize: 15,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  statLabel: {
    color: colors.textSecondary,
    fontSize: 11,
    marginTop: 2,
  },
  statUnavailableTitle: {
    color: colors.text,
    fontSize: 13,
    fontWeight: "700",
    textAlign: "center",
  },
  statUnavailableReason: {
    color: colors.textSecondary,
    fontSize: 11,
    lineHeight: 15,
    marginTop: 2,
    paddingHorizontal: spacing.sm,
    textAlign: "center",
  },
});
