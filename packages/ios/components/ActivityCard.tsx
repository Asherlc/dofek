import { StyleSheet, Text, View } from "react-native";
import { formatDurationRange } from "@dofek/format/format";
import { convertDistance, distanceLabel, type UnitSystem } from "../lib/units";
import { colors } from "../theme";

interface ActivityCardProps {
  name: string;
  activityType: string;
  startedAt: string;
  endedAt: string | null;
  avgHr: number | null;
  maxHr: number | null;
  avgPower: number | null;
  distanceKm?: number | null;
  calories?: number | null;
  unitSystem: UnitSystem;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "--";
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function activityIcon(type: string): string {
  const lower = type.toLowerCase();
  if (lower.includes("run")) return "\u{1F3C3}";
  if (lower.includes("cycl") || lower.includes("bike")) return "\u{1F6B4}";
  if (lower.includes("swim")) return "\u{1F3CA}";
  if (lower.includes("walk") || lower.includes("hike")) return "\u{1F6B6}";
  if (lower.includes("strength") || lower.includes("weight")) return "\u{1F3CB}";
  if (lower.includes("yoga")) return "\u{1F9D8}";
  if (lower.includes("hiit")) return "\u{1F4A5}";
  if (lower.includes("elliptical")) return "\u{1F3C3}\u{200D}\u{2642}\u{FE0F}";
  if (lower.includes("row")) return "\u{1F6A3}";
  return "\u{26A1}";
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

export function ActivityCard({
  name,
  activityType,
  startedAt,
  endedAt,
  avgHr,
  maxHr,
  avgPower,
  distanceKm,
  calories,
  unitSystem,
}: ActivityCardProps) {
  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Text style={styles.icon}>{activityIcon(activityType)}</Text>
        <View style={styles.headerText}>
          <Text style={styles.name} numberOfLines={2}>
            {name || activityType}
          </Text>
          <Text style={styles.time}>
            {formatTime(startedAt)} · {formatDurationRange(startedAt, endedAt)}
          </Text>
        </View>
      </View>

      <View style={styles.separator} />

      <View style={styles.stats}>
        {distanceKm != null && distanceKm > 0 && (
          <Stat
            value={convertDistance(distanceKm, unitSystem).toFixed(2)}
            label="Distance"
            unit={distanceLabel(unitSystem)}
          />
        )}
        {calories != null && calories > 0 && (
          <Stat value={Math.round(calories)} label="Calories" unit="kcal" />
        )}
        {avgHr != null && (
          <Stat value={Math.round(avgHr)} label="Avg HR" unit="bpm" />
        )}
        {maxHr != null && (
          <Stat value={Math.round(maxHr)} label="Max HR" unit="bpm" />
        )}
        {avgPower != null && (
          <Stat value={Math.round(avgPower)} label="Avg Power" unit="W" />
        )}
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
});
