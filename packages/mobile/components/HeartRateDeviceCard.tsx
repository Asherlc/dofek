import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { colors, radius, spacing } from "../theme";

export type HeartRateConnectionState = "disconnected" | "connecting" | "connected";

export interface HeartRateDeviceCardProps {
  /** Whether Bluetooth is powered on and available. */
  bluetoothAvailable: boolean;
  connectionState: HeartRateConnectionState;
  /** Name of the connected monitor, when known. */
  deviceName?: string | null;
  /** Latest heart-rate reading in beats per minute, or null before the first. */
  liveBpm?: number | null;
  onConnect: () => void;
  onDisconnect: () => void;
}

/**
 * Card for pairing and monitoring a Bluetooth heart-rate strap during activity
 * recording. Purely presentational — the record screen wires the native
 * connect/disconnect handlers and live-measurement events.
 */
export function HeartRateDeviceCard({
  bluetoothAvailable,
  connectionState,
  deviceName,
  liveBpm,
  onConnect,
  onDisconnect,
}: HeartRateDeviceCardProps) {
  return (
    <View style={styles.card}>
      <Text style={styles.title}>Heart Rate Monitor</Text>

      {!bluetoothAvailable ? (
        <Text style={styles.hint}>Turn on Bluetooth to connect a heart-rate monitor.</Text>
      ) : connectionState === "connected" ? (
        <View style={styles.connectedRow}>
          <View style={styles.readingBlock}>
            <Text style={styles.bpmValue}>{liveBpm != null ? liveBpm : "—"}</Text>
            <Text style={styles.bpmUnit}>bpm</Text>
          </View>
          <View style={styles.connectedInfo}>
            <Text style={styles.deviceName} numberOfLines={1}>
              {deviceName?.trim() ? deviceName : "Connected"}
            </Text>
            <Pressable
              style={styles.secondaryButton}
              onPress={onDisconnect}
              accessibilityRole="button"
              accessibilityLabel="Disconnect heart-rate monitor"
            >
              <Text style={styles.secondaryButtonText}>Disconnect</Text>
            </Pressable>
          </View>
        </View>
      ) : connectionState === "connecting" ? (
        <View style={styles.connectingRow}>
          <ActivityIndicator color={colors.accent} />
          <Text style={styles.hint}>Searching for a heart-rate monitor…</Text>
        </View>
      ) : (
        <Pressable
          style={styles.primaryButton}
          onPress={onConnect}
          accessibilityRole="button"
          accessibilityLabel="Connect heart-rate monitor"
        >
          <Text style={styles.primaryButtonText}>Connect Monitor</Text>
        </Pressable>
      )}
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
  hint: {
    color: colors.textTertiary,
    fontSize: 13,
    lineHeight: 18,
  },
  connectedRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
  readingBlock: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 4,
  },
  bpmValue: {
    color: colors.danger,
    fontSize: 40,
    fontWeight: "800",
  },
  bpmUnit: {
    color: colors.textTertiary,
    fontSize: 14,
    marginBottom: 6,
  },
  connectedInfo: {
    flex: 1,
    alignItems: "flex-end",
    gap: spacing.xs,
  },
  deviceName: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "600",
  },
  connectingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  primaryButton: {
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    paddingVertical: spacing.sm,
    alignItems: "center",
  },
  primaryButtonText: {
    color: "#ffffff",
    fontSize: 15,
    fontWeight: "700",
  },
  secondaryButton: {
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.md,
  },
  secondaryButtonText: {
    color: colors.textSecondary,
    fontSize: 13,
    fontWeight: "600",
  },
});
