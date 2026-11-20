import { type StyleProp, StyleSheet, Text, View, type ViewStyle } from "react-native";
import Svg, { Path, Rect } from "react-native-svg";
import type { WhoopDeviceSummary } from "../modules/whoop-ble";
import { colors, fontSize, fontWeight, operationalStatusColors, radius, spacing } from "../theme";

type BatteryReading = WhoopDeviceSummary["battery"];

export function whoopBatteryLabels({ percentage, isCharging }: BatteryReading) {
  const level = percentage === null ? "Battery unavailable" : `${percentage}%`;
  const charging =
    isCharging === null ? "Charging unknown" : isCharging ? "Charging" : "Not charging";
  const accessibleLevel = percentage === null ? level : `Battery ${level}`;
  return { level, charging, accessibilityLabel: `${accessibleLevel}, ${charging}` };
}

export function WhoopBatteryStatus({
  percentage,
  isCharging,
  style,
}: BatteryReading & { style?: StyleProp<ViewStyle> }) {
  const { level, charging } = whoopBatteryLabels({ percentage, isCharging });

  return (
    <View style={[styles.readout, style]}>
      {percentage === null ? (
        <Text style={[styles.statusText, styles.unavailable]}>{level}</Text>
      ) : (
        <BatteryBadge percentage={percentage} label={level} />
      )}
      <Text style={styles.statusText}>{charging}</Text>
    </View>
  );
}

function BatteryBadge({ percentage, label }: { percentage: number; label: string }) {
  const { foreground, surface } =
    percentage === 0
      ? operationalStatusColors.danger
      : percentage <= 20
        ? operationalStatusColors.warning
        : operationalStatusColors.success;

  return (
    <View style={[styles.badge, { backgroundColor: surface }]}>
      <Svg viewBox="0 0 16 16" width={16} height={16} accessible={false} aria-hidden>
        <Rect
          x={2}
          y={4.5}
          width={10.5}
          height={7}
          rx={1.5}
          fill="none"
          stroke={foreground}
          strokeWidth={1.5}
        />
        <Path d="M14.5 7v2" stroke={foreground} strokeWidth={1.5} strokeLinecap="round" />
      </Svg>
      <Text style={[styles.percent, { color: foreground }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  readout: {
    alignItems: "flex-end",
    gap: spacing.xs,
  },
  badge: {
    alignItems: "center",
    borderRadius: radius.full,
    flexDirection: "row",
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  percent: {
    fontSize: fontSize.base,
    fontVariant: ["tabular-nums"],
    fontWeight: fontWeight.bold,
  },
  statusText: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    textAlign: "right",
  },
  unavailable: {
    fontWeight: fontWeight.bold,
  },
});
