import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors, radius, spacing } from "../theme";

export interface HeartRateDeviceCardProps {
  connectedDeviceCount: number;
  error: string | null;
  onManageDevices: () => void;
}

/**
 * Summary of shared Bluetooth device connections during activity recording.
 * Device connection and pairing remain in the Bluetooth device manager.
 */
export function HeartRateDeviceCard({
  connectedDeviceCount,
  error,
  onManageDevices,
}: HeartRateDeviceCardProps) {
  const connectionSummary =
    error ??
    (connectedDeviceCount === 0
      ? "No Bluetooth devices connected"
      : `${connectedDeviceCount} Bluetooth device${connectedDeviceCount === 1 ? "" : "s"} connected`);

  return (
    <View style={styles.card}>
      <Text style={styles.title}>Bluetooth Devices</Text>
      <Text style={error === null ? styles.summary : styles.error}>{connectionSummary}</Text>
      <Pressable
        style={styles.manageButton}
        onPress={onManageDevices}
        accessibilityRole="button"
        accessibilityLabel="Manage Bluetooth devices"
      >
        <Text style={styles.manageButtonText}>Manage Devices</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.sm,
  },
  title: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "700",
    textTransform: "uppercase",
  },
  summary: {
    color: colors.textTertiary,
    fontSize: 13,
    lineHeight: 18,
  },
  error: {
    color: colors.danger,
    fontSize: 13,
    lineHeight: 18,
  },
  manageButton: {
    alignItems: "center",
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.md,
  },
  manageButtonText: {
    color: colors.textSecondary,
    fontSize: 13,
    fontWeight: "600",
  },
});
