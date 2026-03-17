import { StyleSheet, Text, View } from "react-native";

interface ActivityCardProps {
  name: string;
  activityType: string;
  startedAt: string;
  endedAt: string | null;
  avgHr: number | null;
  maxHr: number | null;
  avgPower: number | null;
}

function formatDuration(start: string, end: string | null): string {
  if (!end) return "--";
  const ms = new Date(end).getTime() - new Date(start).getTime();
  const totalMinutes = Math.round(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  return `${hours}h ${minutes}m`;
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
            {formatTime(startedAt)} · {formatDuration(startedAt, endedAt)}
          </Text>
        </View>
      </View>
      <View style={styles.stats}>
        {avgHr != null && (
          <View style={styles.stat}>
            <Text style={styles.statValue}>{Math.round(avgHr)}</Text>
            <Text style={styles.statLabel}>Avg HR</Text>
          </View>
        )}
        {maxHr != null && (
          <View style={styles.stat}>
            <Text style={styles.statValue}>{Math.round(maxHr)}</Text>
            <Text style={styles.statLabel}>Max HR</Text>
          </View>
        )}
        {avgPower != null && (
          <View style={styles.stat}>
            <Text style={styles.statValue}>{Math.round(avgPower)}</Text>
            <Text style={styles.statLabel}>Avg W</Text>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: "#1c1c1e",
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
    color: "#fff",
  },
  time: {
    fontSize: 13,
    color: "#8e8e93",
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
    color: "#fff",
    fontVariant: ["tabular-nums"],
  },
  statLabel: {
    fontSize: 11,
    color: "#636366",
    marginTop: 2,
  },
});
