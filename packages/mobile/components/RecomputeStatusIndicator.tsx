import type { ProcessingDisplayStatus } from "@dofek/providers/processing-status";
import { operationalStatusColors } from "@dofek/scoring/colors";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { colors, spacing } from "../theme";

interface RecomputeStatusIndicatorProps {
  label: string;
  progress: number | null;
  status: ProcessingDisplayStatus;
}

function ringColor(status: ProcessingDisplayStatus): string {
  if (status === "ready") return operationalStatusColors.success.indicator;
  if (status === "delayed") return operationalStatusColors.warning.indicator;
  if (status === "failed" || status === "blocked") {
    return operationalStatusColors.danger.indicator;
  }
  if (status === "cancelled") return operationalStatusColors.neutral.indicator;
  return operationalStatusColors.info.indicator;
}

export function RecomputeStatusIndicator({
  label,
  progress,
  status,
}: RecomputeStatusIndicatorProps) {
  const size = 32;
  const radius = 12;
  const circumference = 2 * Math.PI * radius;
  const clampedProgress = progress === null ? null : Math.min(100, Math.max(0, progress));
  const color = ringColor(status);

  return (
    <View
      style={styles.container}
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityValue={{
        min: 0,
        max: 100,
        now: clampedProgress ?? undefined,
      }}
    >
      {clampedProgress === null ? (
        <ActivityIndicator color={color} size="small" />
      ) : (
        <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          <Circle
            cx="16"
            cy="16"
            r={radius}
            fill="none"
            stroke={color}
            strokeWidth="3"
            opacity={0.2}
          />
          <Circle
            cx="16"
            cy="16"
            r={radius}
            fill="none"
            stroke={color}
            strokeWidth="3"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - clampedProgress / 100)}
            rotation="-90"
            origin="16, 16"
          />
        </Svg>
      )}
      <Text style={styles.label}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
    justifyContent: "center",
  },
  label: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "600",
  },
});
