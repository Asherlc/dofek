import { StyleSheet, Text, View } from "react-native";
import { formatDurationRange } from "../lib/format";
import { colors } from "../theme";

interface ActivityCardProps {
  name: string;
  activityType: string;
  startedAt: string;
  endedAt: string | null;
  avgHr: number | null;
  maxHr: number | null;
  avgPower: number | null;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function activityIcon(type: string): string {
  const lower = type.toLowerCase();
  if (lower.includes("run")) return "\u{1F3C3}";
  if (lower.includes("cycl") || lower.includes("bike")) return "\u{1F6B4}";
  if (lower.includes("swim")) return "\u{1F3CA}";
  if (lower.includes("walk") || lower.includes("hike")) return "\u{1F6B6}";
  if (lower.includes("strength") || lower.includes("weight")) return "\u{1F3CB}";
  if (lower.includes("yoga")) return "\u{1F9D8}";
  return "\u{26A1}";
}

export function ActivityCard({
  name,
  activityType,
  startedAt,
  endedAt,
  avgHr,
  maxHr,
  avgPower,
}: ActivityCardProps) {
  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Text style={styles.icon}>{activityIcon(activityType)}</Text>
        <View style={styles.headerText}>
          <Text style={styles.name} numberOfLines={1}>
            {name || activityType}
          </Text>
          <Text style={styles.time}>
            {formatTime(startedAt)} · {formatDurationRange(startedAt, endedAt)}
          </Text>
        </View>
      </View>
      <View style={styles.stats}>
        {avgHr != null && (
          <View style={styles.stat}>
            <Text style={styles.statValue}>{Math.round(avgHr)}</Text>
            <Text style={styles.statLabel}>Avg Heart Rate</Text>
          </View>
        )}
        {maxHr != null && (
          <View style={styles.stat}>
            <Text style={styles.statValue}>{Math.round(maxHr)}</Text>
            <Text style={styles.statLabel}>Max Heart Rate</Text>
          </View>
        )}
        {avgPower != null && (
          <View style={styles.stat}>
            <Text style={styles.statValue}>{Math.round(avgPower)}</Text>
            <Text style={styles.statLabel}>Avg Power</Text>
          </View>
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
    fontWeight: "600",
    color: colors.text,
  },
  time: {
    fontSize: 13,
    color: colors.textSecondary,
    marginTop: 2,
  },
  stats: {
    flexDirection: "row",
    gap: 24,
  },
  stat: {
    alignItems: "center",
  },
  statValue: {
    fontSize: 18,
    fontWeight: "700",
    color: colors.text,
    fontVariant: ["tabular-nums"],
  },
  statLabel: {
    fontSize: 11,
    color: colors.textTertiary,
    marginTop: 2,
  },
});
