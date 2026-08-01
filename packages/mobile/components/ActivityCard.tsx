import {
  activityDataStateLabel,
  formatActivityMetric,
  type ActivityDataState,
  type ActivityMetric,
} from "@dofek/format/activity-data-state";
import { formatDurationRange, formatNumber, formatTimeOnly } from "@dofek/format/format";
import type { UnitConverter } from "@dofek/format/units";
import { getActivityIconInfo } from "@dofek/training/activity-icons";
import { formatActivityTypeLabel } from "@dofek/training/training";
import { StyleSheet, Text, View } from "react-native";
import { colors } from "../theme";

interface ActivityCardProps {
  name: string;
  activityType: string;
  startedAt: string;
  endedAt: string | null;
  avgHr: number | null;
  maxHr: number | null;
  avgPower: number | null;
  distanceKm: number | null;
  distanceState: ActivityDataState;
  units: UnitConverter;
}

function activityIcon(type: string): string {
  return getActivityIconInfo(type).emoji;
}

function Stat({ value, label, unit }: { value: string | number; label: string; unit?: string }) {
  return (
    <View style={styles.stat}>
      <View style={styles.statValueRow}>
        <Text style={styles.statValue}>{value}</Text>
        {unit && <Text style={styles.statUnit}>{unit}</Text>}
      </View>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function UnavailableStat({ metric }: { metric: ActivityMetric }) {
  if (metric.status === "available") return null;
  return (
    <View style={styles.unavailableStat} accessibilityLabel={`${metric.label} ${activityDataStateLabel(metric.status)}: ${metric.reason}`}>
      <Text style={styles.statUnavailableTitle}>
        {metric.label} {activityDataStateLabel(metric.status)}
      </Text>
      <Text style={styles.statUnavailableReason}>{metric.reason}</Text>
    </View>
  );
}

export function ActivityCard({
  name,
  activityType,
  startedAt,
  endedAt,
  avgHr,
  maxHr,
  avgPower,
  distanceKm,
  distanceState,
  units,
}: ActivityCardProps) {
  const distanceMetric = formatActivityMetric(
    "Distance",
    distanceKm,
    distanceState,
    (value) => formatNumber(units.convertDistance(value), 2),
  );

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Text style={styles.icon}>{activityIcon(activityType)}</Text>
        <View style={styles.headerText}>
          <Text style={styles.name} numberOfLines={2}>
            {name || formatActivityTypeLabel(activityType)}
          </Text>
          <Text style={styles.time}>
            {formatTimeOnly(startedAt)} · {formatDurationRange(startedAt, endedAt)}
          </Text>
        </View>
      </View>

      <View style={styles.separator} />

      <View style={styles.stats}>
        {distanceMetric.status === "available" ? (
          <Stat value={distanceMetric.value} label="Distance" unit={units.distanceLabel} />
        ) : (
          <UnavailableStat metric={distanceMetric} />
        )}
        {avgHr != null && <Stat value={Math.round(avgHr)} label="Avg HR" unit="bpm" />}
        {maxHr != null && <Stat value={Math.round(maxHr)} label="Max HR" unit="bpm" />}
        {avgPower != null && <Stat value={Math.round(avgPower)} label="Avg Power" unit="W" />}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    padding: 16,
    gap: 12,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  icon: {
    fontSize: 28,
  },
  headerText: {
    flex: 1,
  },
  name: {
    fontSize: 16,
    fontWeight: "700",
    color: colors.text,
  },
  time: {
    fontSize: 13,
    color: colors.textSecondary,
    marginTop: 2,
  },
  separator: {
    height: 1,
    backgroundColor: colors.surfaceSecondary,
    marginVertical: 4,
  },
  stats: {
    flexDirection: "row",
    flexWrap: "wrap",
    rowGap: 16,
    columnGap: 24,
  },
  stat: {
    minWidth: 60,
  },
  unavailableStat: {
    minWidth: 120,
    maxWidth: 190,
  },
  statValueRow: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: 2,
  },
  statValue: {
    fontSize: 17,
    fontWeight: "700",
    color: colors.text,
    fontVariant: ["tabular-nums"],
  },
  statUnit: {
    fontSize: 12,
    color: colors.textTertiary,
    fontWeight: "600",
  },
  statLabel: {
    fontSize: 11,
    color: colors.textSecondary,
    textTransform: "uppercase",
    fontWeight: "600",
    letterSpacing: 0.5,
    marginTop: 2,
  },
  statUnavailableTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: colors.text,
  },
  statUnavailableReason: {
    fontSize: 11,
    color: colors.textSecondary,
    marginTop: 2,
  },
});
