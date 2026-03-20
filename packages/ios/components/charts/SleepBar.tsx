import { StyleSheet, Text, View } from "react-native";
import { formatDurationMinutes } from "../../lib/format";
import { colors } from "../../theme";

interface SleepBarProps {
  /** Total sleep duration in minutes */
  durationMinutes: number;
  /** Percentage of each sleep stage (0-100) */
  deepPercentage: number;
  remPercentage: number;
  lightPercentage: number;
  awakePercentage: number;
  /** Show stage legend */
  showLegend?: boolean;
}

const STAGE_COLORS = {
  deep: "#5E35B1", // deep purple
  rem: "#42A5F5", // blue
  light: "#78909C", // grey-blue
  awake: "#FF8A65", // orange
};

export function SleepBar({
  durationMinutes,
  deepPercentage,
  remPercentage,
  lightPercentage,
  awakePercentage,
  showLegend = true,
}: SleepBarProps) {
  const stages = [
    { key: "deep", label: "Deep", percentage: deepPercentage, color: STAGE_COLORS.deep },
    { key: "rem", label: "REM Sleep", percentage: remPercentage, color: STAGE_COLORS.rem },
    { key: "light", label: "Light", percentage: lightPercentage, color: STAGE_COLORS.light },
    { key: "awake", label: "Awake", percentage: awakePercentage, color: STAGE_COLORS.awake },
  ];

  return (
    <View style={styles.container}>
      <Text style={styles.duration}>{formatDurationMinutes(durationMinutes)}</Text>
      <View style={styles.bar}>
        {stages.map((stage) =>
          stage.percentage > 0 ? (
            <View
              key={stage.key}
              style={[
                styles.segment,
                {
                  flex: stage.percentage,
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
                {stage.label} {Math.round(stage.percentage)}%
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
    color: colors.text,
    fontVariant: ["tabular-nums"],
  },
  bar: {
    flexDirection: "row",
    height: 12,
    borderRadius: 6,
    overflow: "hidden",
    backgroundColor: colors.surfaceSecondary,
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
    flexShrink: 1,
    maxWidth: "48%",
  },
  legendDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  legendLabel: {
    fontSize: 12,
    color: colors.textSecondary,
    flexShrink: 1,
  },
});
