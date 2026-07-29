import { formatMeasurementText, type UnitConverter } from "@dofek/format/units";
import { StyleSheet, Text, View } from "react-native";
import { colors, radius, spacing } from "../theme";

type ActivityStat =
  | { status: "available"; label: string; value: string }
  | { status: "unavailable"; label: string; reason: string };

export function ActivityMetricStrip({
  activity,
  units,
}: {
  activity: {
    location: {
      distanceMeters: number | null;
      elevationGainM: number | null;
    } | null;
    stats: ActivityStat[];
  };
  units: UnitConverter;
}) {
  const stats: ActivityStat[] =
    activity.location != null
      ? [
          {
            status: "available",
            label: "Distance",
            value:
              activity.location.distanceMeters != null
                ? formatMeasurementText(
                    units.formatDistance(activity.location.distanceMeters / 1000),
                  )
                : "—",
          },
          {
            status: "available",
            label: "Elevation",
            value:
              activity.location.elevationGainM != null
                ? formatMeasurementText(units.formatElevation(activity.location.elevationGainM))
                : "—",
          },
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
          <View key={stat.label} style={styles.statBadge}>
            <Text style={styles.statUnavailableTitle}>{stat.label} unavailable</Text>
            <Text style={styles.statUnavailableReason}>{stat.reason}</Text>
          </View>
        ),
      )}
    </View>
  );
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
