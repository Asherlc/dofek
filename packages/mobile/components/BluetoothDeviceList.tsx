import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import type { BluetoothDevice } from "../lib/bluetooth-device-catalog";
import { colors, fontSize, fontWeight, radius, spacing } from "../theme";
import { QueryStatePanel } from "./QueryStatePanel";

export interface BluetoothDeviceListProps {
  connecting: boolean;
  devices: BluetoothDevice[];
  error: string | null;
  loading: boolean;
  onConnectDevice: () => void;
  onSelectDevice: (device: BluetoothDevice) => void;
}

function diagnosticSummary(device: BluetoothDevice): string {
  if (device.kind === "whoop") {
    return `${device.diagnostics.imuBufferedSamples} IMU samples · ${device.diagnostics.realtimeBufferedSamples} realtime samples`;
  }

  const heartRate =
    device.diagnostics.lastHeartRateBpm === null
      ? "No heart-rate reading"
      : `${device.diagnostics.lastHeartRateBpm} bpm`;
  return `${heartRate} · ${device.diagnostics.bufferedSampleCount} buffered samples`;
}

export function BluetoothDeviceList({
  connecting,
  devices,
  error,
  loading,
  onConnectDevice,
  onSelectDevice,
}: BluetoothDeviceListProps) {
  if (loading && devices.length === 0) {
    return <QueryStatePanel variant="loading" minHeight={180} />;
  }

  if (error && devices.length === 0) {
    return (
      <View style={styles.content}>
        <QueryStatePanel
          variant="error"
          title="Could not load Bluetooth devices"
          message={error}
          minHeight={140}
        />
        <ConnectButton connecting={connecting} onPress={onConnectDevice} />
      </View>
    );
  }

  return (
    <View style={styles.content}>
      {loading ? (
        <View style={styles.refreshingRow} accessibilityLiveRegion="polite">
          <ActivityIndicator color={colors.accent} size="small" />
          <Text style={styles.refreshingText}>Refreshing devices…</Text>
        </View>
      ) : null}
      {devices.length === 0 ? (
        <QueryStatePanel
          variant="empty"
          title="No Bluetooth devices"
          message="No Bluetooth devices found."
          minHeight={140}
        />
      ) : (
        <View style={styles.devices}>
          {devices.map((device) => (
            <Pressable
              key={`${device.kind}:${device.id}`}
              accessibilityRole="button"
              accessibilityLabel={`${device.name}, ${device.connectionState}`}
              onPress={() => onSelectDevice(device)}
              style={styles.deviceRow}
            >
              <View style={styles.deviceText}>
                <Text style={styles.deviceName}>{device.name}</Text>
                <Text style={styles.connectionState}>{device.connectionState}</Text>
                <Text style={styles.diagnostics}>{diagnosticSummary(device)}</Text>
              </View>
              <Text style={styles.chevron}>›</Text>
            </Pressable>
          ))}
        </View>
      )}
      {error ? (
        <QueryStatePanel
          variant="error"
          title="Could not refresh Bluetooth devices"
          message={error}
          minHeight={112}
        />
      ) : null}
      <ConnectButton connecting={connecting} onPress={onConnectDevice} />
    </View>
  );
}

function ConnectButton({ connecting, onPress }: { connecting: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={connecting ? "Connecting Bluetooth device" : "Connect Bluetooth device"}
      accessibilityState={{ busy: connecting, disabled: connecting }}
      disabled={connecting}
      onPress={onPress}
      style={[styles.connectButton, connecting ? styles.disabledButton : null]}
    >
      {connecting ? <ActivityIndicator color={colors.surface} size="small" /> : null}
      <Text style={styles.connectButtonText}>
        {connecting ? "Connecting…" : "Connect Bluetooth device"}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  content: {
    gap: spacing.md,
  },
  devices: {
    gap: spacing.sm,
  },
  deviceRow: {
    alignItems: "center",
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    padding: spacing.md,
  },
  deviceText: {
    flex: 1,
    gap: spacing.xs,
  },
  deviceName: {
    color: colors.text,
    fontSize: fontSize.base,
    fontWeight: fontWeight.bold,
  },
  connectionState: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    textTransform: "capitalize",
  },
  diagnostics: {
    color: colors.textTertiary,
    fontSize: fontSize.xs,
  },
  chevron: {
    color: colors.textTertiary,
    fontSize: fontSize.xl,
  },
  refreshingRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
  },
  refreshingText: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
  },
  connectButton: {
    alignItems: "center",
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    flexDirection: "row",
    gap: spacing.sm,
    justifyContent: "center",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  disabledButton: {
    opacity: 0.6,
  },
  connectButtonText: {
    color: colors.surface,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.bold,
  },
});
