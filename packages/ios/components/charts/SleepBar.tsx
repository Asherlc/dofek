import { StyleSheet, Text, View } from "react-native";

interface SleepBarProps {
  /** Total sleep duration in minutes */
  durationMinutes: number;
  /** Percentage of each sleep stage (0-100) */
  deepPct: number;
  remPct: number;
  lightPct: number;
  awakePct: number;
  /** Show stage legend */
  showLegend?: boolean;
}

const STAGE_COLORS = {
  deep: "#5E35B1", // deep purple
  rem: "#42A5F5", // blue
  light: "#78909C", // grey-blue
  awake: "#FF8A65", // orange
};

function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const mins = Math.round(minutes % 60);
  return `${hours}h ${mins}m`;
}

export function SleepBar({
  durationMinutes,
  deepPct,
  remPct,
  lightPct,
  awakePct,
  showLegend = true,
}: SleepBarProps) {
  const stages = [
    { key: "deep", label: "Deep", pct: deepPct, color: STAGE_COLORS.deep },
    { key: "rem", label: "REM", pct: remPct, color: STAGE_COLORS.rem },
    { key: "light", label: "Light", pct: lightPct, color: STAGE_COLORS.light },
    { key: "awake", label: "Awake", pct: awakePct, color: STAGE_COLORS.awake },
  ];

  return (
    <View style={styles.container}>
      <Text style={styles.duration}>{formatDuration(durationMinutes)}</Text>
      <View style={styles.bar}>
        {stages.map((stage) =>
          stage.pct > 0 ? (
            <View
              key={stage.key}
              style={[
                styles.segment,
                {
                  flex: stage.pct,
                  backgroundColor: stage.color,
                },
              ]}
            />
          ) : null,
        )}
      </View>
      {showLegend && (
        <View style={styles.legend}>
          {stages.map((stage) => (
            <View key={stage.key} style={styles.legendItem}>
              <View style={[styles.legendDot, { backgroundColor: stage.color }]} />
              <Text style={styles.legendLabel}>
                {stage.label} {Math.round(stage.pct)}%
              </Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 8,
  },
  duration: {
    fontSize: 28,
    fontWeight: "700",
    color: "#fff",
    fontVariant: ["tabular-nums"],
  },
  bar: {
    flexDirection: "row",
    height: 12,
    borderRadius: 6,
    overflow: "hidden",
    backgroundColor: "#2a2a2e",
  },
  segment: {
    height: "100%",
  },
  legend: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12,
    marginTop: 4,
  },
  legendItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  legendDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  legendLabel: {
    fontSize: 12,
    color: "#8e8e93",
  },
});
