import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import type { BluetoothDevice } from "../lib/bluetooth-device-catalog";
import { bluetoothDeviceStatusLabel } from "../lib/bluetooth-device-status-label";
import { colors, fontSize, fontWeight, radius, spacing } from "../theme";
import { QueryStatePanel } from "./QueryStatePanel";
import { WhoopBatteryStatus, whoopBatteryLabels } from "./WhoopBatteryStatus";

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
    return `${device.diagnostics.imuBufferedSamples} inertial measurement unit (IMU) samples · ${device.diagnostics.realtimeBufferedSamples} realtime samples`;
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
  const whoopDevices = devices.filter((device) => device.kind === "whoop");
  const heartRateDevices = devices.filter((device) => device.kind === "heart-rate");
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
          <DeviceSection title="WHOOP" devices={whoopDevices} onSelectDevice={onSelectDevice} />
          <DeviceSection
            title="Heart-rate monitors"
            devices={heartRateDevices}
            onSelectDevice={onSelectDevice}
          />
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

function DeviceSection({
  devices,
  onSelectDevice,
  title,
}: {
  devices: BluetoothDevice[];
  onSelectDevice: (device: BluetoothDevice) => void;
  title: string;
}) {
  return (
    <View style={styles.section}>
      <Text accessibilityRole="header" style={styles.sectionTitle}>
        {title}
      </Text>
      {devices.map((device) => (
        <DeviceRow
          key={`${device.kind}:${device.id}`}
          device={device}
          onSelectDevice={onSelectDevice}
        />
      ))}
    </View>
  );
}

function DeviceRow({
  device,
  onSelectDevice,
}: {
  device: BluetoothDevice;
  onSelectDevice: (device: BluetoothDevice) => void;
}) {
  const connected = device.connectionState === "ready" || device.connectionState === "streaming";
  const battery =
    device.kind === "whoop" && device.battery
      ? connected
        ? device.battery
        : { percentage: null, isCharging: null }
      : undefined;
  const statusLabel = bluetoothDeviceStatusLabel(device);
  const deviceLabel = `${device.name}, ${statusLabel}`;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        battery ? `${deviceLabel}, ${whoopBatteryLabels(battery).accessibilityLabel}` : deviceLabel
      }
      onPress={() => onSelectDevice(device)}
      style={styles.deviceRow}
    >
      <View style={styles.deviceText}>
        <Text style={styles.deviceName}>{device.name}</Text>
        <Text style={styles.connectionState}>{statusLabel}</Text>
        <Text style={styles.diagnostics}>{diagnosticSummary(device)}</Text>
      </View>
      {battery ? <WhoopBatteryStatus {...battery} style={styles.battery} /> : null}
      <Text style={styles.chevron}>›</Text>
    </Pressable>
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
    gap: spacing.md,
  },
  section: {
    gap: spacing.sm,
  },
  sectionTitle: {
    color: colors.textSecondary,
    fontSize: fontSize.xs,
    fontWeight: fontWeight.bold,
    textTransform: "uppercase",
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
  battery: {
    marginHorizontal: spacing.sm,
    maxWidth: "42%",
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
