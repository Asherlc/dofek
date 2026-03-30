import { formatDurationMinutes } from "@dofek/format/format";
import { StyleSheet, Text, View } from "react-native";
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

/**
 * Round percentages so they sum to exactly 100.
 * This prevents impossible displays like "97% light + 4% awake = 101%".
 *
 * Approach: round each value normally, then adjust the largest value to
 * absorb any rounding drift. The largest stage is least visually affected
 * by a 1-point adjustment.
 */
export function normalizePercentages(values: number[]): number[] {
  const total = values.reduce((sum, v) => sum + v, 0);
  if (total === 0) return values.map(() => 0);

  // Scale so values sum to 100, then round each
  const scale = 100 / total;
  const rounded = values.map((v) => Math.round(v * scale));
  const diff = rounded.reduce((sum, v) => sum + v, 0) - 100;

  if (diff !== 0) {
    // Adjust the largest value — least noticeable visually
    let maxIndex = 0;
    for (let i = 1; i < rounded.length; i++) {
      if (rounded[i] > rounded[maxIndex]) maxIndex = i;
    }
    rounded[maxIndex] -= diff;
  }

  return rounded;
}

export function SleepBar({
  durationMinutes,
  deepPercentage,
  remPercentage,
  lightPercentage,
  awakePercentage,
  showLegend = true,
}: SleepBarProps) {
  const rawPercentages = [deepPercentage, remPercentage, lightPercentage, awakePercentage];
  const displayPercentages = normalizePercentages(rawPercentages);

  const stages = [
    {
      key: "deep",
      label: "Deep",
      percentage: deepPercentage,
      displayPct: displayPercentages[0] ?? 0,
      color: STAGE_COLORS.deep,
    },
    {
      key: "rem",
      label: "REM Sleep",
      percentage: remPercentage,
      displayPct: displayPercentages[1] ?? 0,
      color: STAGE_COLORS.rem,
    },
    {
      key: "light",
      label: "Light",
      percentage: lightPercentage,
      displayPct: displayPercentages[2] ?? 0,
      color: STAGE_COLORS.light,
    },
    {
      key: "awake",
      label: "Awake",
      percentage: awakePercentage,
      displayPct: displayPercentages[3] ?? 0,
      color: STAGE_COLORS.awake,
    },
  ];

  return (
    <View style={styles.container}>
      <Text style={styles.duration}>{formatDurationMinutes(durationMinutes)}</Text>
      <View style={styles.bar}>
        {stages.map((stage) =>
          stage.displayPct > 0 ? (
            <View
              key={stage.key}
              style={[
                styles.segment,
                {
                  flex: stage.displayPct,
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
                {stage.label} {stage.displayPct}%
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
