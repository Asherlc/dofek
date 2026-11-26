import { userFacingErrorMessage } from "@dofek/format/user-facing-error";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { QueryStatePanel } from "../../components/QueryStatePanel";
import { WhoopBatteryStatus } from "../../components/WhoopBatteryStatus";
import {
  type BluetoothDevice,
  getBluetoothDevices,
  subscribeBluetoothDevices,
} from "../../lib/bluetooth-device-catalog";
import { bluetoothDeviceStatusLabel } from "../../lib/bluetooth-device-status-label";
import { captureException } from "../../lib/telemetry";
import { isUnsupportedWhoopDevice } from "../../lib/whoop-ble-errors";
import {
  connect as connectHeartRate,
  disconnect as disconnectHeartRate,
  forget as forgetHeartRate,
} from "../../modules/ble-heart-rate";
import {
  connect as connectWhoop,
  disconnect as disconnectWhoop,
  findWhoop,
  setManagedHistoryEnabled,
  startImuStreaming,
  stopImuStreaming,
} from "../../modules/whoop-ble";
import { colors, fontSize, fontWeight, radius, spacing } from "../../theme";

type DeviceAction =
  | "connect"
  | "disconnect"
  | "forget"
  | "start-streaming"
  | "stop-streaming"
  | "toggle-managed-history";

function errorMessage(error: unknown): string {
  return userFacingErrorMessage(
    error,
    "The Bluetooth device could not be updated. Check Bluetooth and try again.",
  );
}

function isConnected(connectionState: string): boolean {
  return (
    connectionState === "connected" ||
    connectionState === "ready" ||
    connectionState === "streaming"
  );
}

export default function BluetoothDeviceDetailScreen() {
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const router = useRouter();
  const requestedId = Array.isArray(params.id) ? params.id[0] : params.id;
  const mounted = useRef(true);
  const [devices, setDevices] = useState<BluetoothDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<DeviceAction | null>(null);
  const device = devices.find((candidate) => candidate.id === requestedId);

  const loadDevice = useCallback(async () => {
    try {
      const nextDevices = await getBluetoothDevices();
      if (!mounted.current) return;
      setDevices(nextDevices);
      setError(null);
    } catch (loadError: unknown) {
      captureException(loadError, { source: "bluetooth-device-detail-load" });
      if (mounted.current) {
        setError(errorMessage(loadError));
      }
    } finally {
      if (mounted.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    let subscription: ReturnType<typeof subscribeBluetoothDevices> | undefined;
    try {
      subscription = subscribeBluetoothDevices((update) => {
        if (!mounted.current) return;
        setLoading(false);
        if (update.state === "ready") {
          setDevices(update.devices);
          setError(null);
        } else {
          setError(
            userFacingErrorMessage(
              update.error,
              "The Bluetooth device could not be refreshed. Check Bluetooth and try again.",
            ),
          );
        }
      });
    } catch (subscriptionError: unknown) {
      captureException(subscriptionError, { source: "bluetooth-device-detail-subscribe" });
      setError(errorMessage(subscriptionError));
    }
    void loadDevice();

    return () => {
      mounted.current = false;
      subscription?.remove();
    };
  }, [loadDevice]);

  const runAction = useCallback(
    async (action: DeviceAction) => {
      if (!device || pendingAction) return;
      setPendingAction(action);
      setError(null);
      try {
        if (device.kind === "heart-rate") {
          if (action === "connect") {
            await connectHeartRate(device.id);
          } else if (action === "disconnect") {
            disconnectHeartRate(device.id);
          } else {
            forgetHeartRate(device.id);
            router.back();
            return;
          }
        } else if (action === "connect") {
          // Unsupported NO_SERVICE identity must not be reused; rescan for a supported strap.
          const peripheralId = device.unsupportedDevice
            ? (await findWhoop())?.id
            : (device.peripheralId ?? (await findWhoop())?.id);
          if (!peripheralId) {
            throw new Error("WHOOP strap not found");
          }
          try {
            await connectWhoop(peripheralId);
          } catch (connectionError: unknown) {
            if (!isUnsupportedWhoopDevice(connectionError)) throw connectionError;
          }
        } else if (action === "disconnect") {
          disconnectWhoop();
        } else if (action === "start-streaming") {
          await startImuStreaming();
        } else if (action === "stop-streaming") {
          await stopImuStreaming();
        } else if (action === "toggle-managed-history") {
          const peripheralId = device.peripheralId;
          if (!peripheralId) {
            throw new Error("Cannot toggle managed history without a peripheral ID");
          }
          const currentState = device.managedHistoryEnabled ?? false;
          await setManagedHistoryEnabled(peripheralId, !currentState);
        }
        await loadDevice();
      } catch (actionError: unknown) {
        captureException(actionError, {
          source: `bluetooth-device-detail-${action}`,
          deviceKind: device.kind,
        });
        if (mounted.current) {
          setError(errorMessage(actionError));
        }
      } finally {
        if (mounted.current) {
          setPendingAction(null);
        }
      }
    },
    [device, loadDevice, pendingAction, router],
  );

  const handleManagedHistoryPress = () => {
    if (
      pendingAction ||
      !device ||
      device.kind !== "whoop" ||
      !device.peripheralId ||
      device.managedHistoryEnabled === undefined
    ) {
      return;
    }
    const currentState = device.managedHistoryEnabled;
    if (currentState) {
      void runAction("toggle-managed-history");
      return;
    }
    Alert.alert(
      "Enable Dofek-managed history",
      "WHOOP Bluetooth access must be off to enable Dofek-managed history. WHOOP may miss samples if both apps sync. Dofek starts on the next connection.",
      [
        {
          text: "Enable",
          style: "default",
          onPress: () => void runAction("toggle-managed-history"),
        },
        { text: "Cancel", style: "cancel" },
      ],
    );
  };

  if (loading && devices.length === 0) {
    return (
      <View style={styles.stateContainer}>
        <QueryStatePanel variant="loading" minHeight={180} />
      </View>
    );
  }

  if (!device) {
    return (
      <View style={styles.stateContainer}>
        <QueryStatePanel
          variant={error ? "error" : "empty"}
          title={error ? "Could not load Bluetooth device" : "Bluetooth device unavailable"}
          message={error ?? "Bluetooth device not found."}
          minHeight={180}
        />
      </View>
    );
  }

  const connected = isConnected(device.connectionState);
  const hasCurrentBattery =
    device.connectionState === "ready" || device.connectionState === "streaming";
  const battery =
    device.kind === "whoop" && device.battery
      ? hasCurrentBattery
        ? device.battery
        : { percentage: null, isCharging: null }
      : undefined;
  const connectionAction: DeviceAction = connected ? "disconnect" : "connect";
  const connectionLabel = connected ? `Disconnect ${device.name}` : `Connect ${device.name}`;
  const statusLabel = bluetoothDeviceStatusLabel(device);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>{device.name}</Text>
      <Text style={styles.connectionState}>{statusLabel}</Text>

      {battery ? (
        <View style={[styles.card, styles.batteryCard]}>
          <Text accessibilityRole="header" style={styles.cardTitle}>
            Battery
          </Text>
          <WhoopBatteryStatus {...battery} style={styles.batteryReadout} />
        </View>
      ) : null}

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Native diagnostics</Text>
        {device.kind === "heart-rate" ? (
          <>
            <Text style={styles.primaryDiagnostic}>
              {device.diagnostics.lastHeartRateBpm === null
                ? "No heart-rate reading"
                : `${device.diagnostics.lastHeartRateBpm} bpm`}
            </Text>
            <Text style={styles.diagnostic}>
              R-R intervals:{" "}
              {device.diagnostics.lastRrIntervalsMs.length > 0
                ? `${device.diagnostics.lastRrIntervalsMs.join(", ")} ms`
                : "None"}
            </Text>
            <Text style={styles.diagnostic}>
              Buffered samples: {device.diagnostics.bufferedSampleCount}
            </Text>
            <Text style={styles.diagnostic}>
              Last measurement: {device.diagnostics.lastMeasurementAt ?? "None"}
            </Text>
          </>
        ) : (
          <>
            <Text style={styles.diagnostic}>
              Inertial measurement unit (IMU) buffered samples:{" "}
              {device.diagnostics.imuBufferedSamples}
            </Text>
            <Text style={styles.diagnostic}>
              Realtime buffered samples: {device.diagnostics.realtimeBufferedSamples}
            </Text>
          </>
        )}
      </View>

      {error ? (
        <QueryStatePanel
          variant="error"
          title="Bluetooth action failed"
          message={error}
          minHeight={112}
        />
      ) : null}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={connectionLabel}
        accessibilityState={{
          busy: pendingAction === connectionAction,
          disabled: pendingAction !== null,
        }}
        disabled={pendingAction !== null}
        onPress={() => void runAction(connectionAction)}
        style={[styles.primaryButton, pendingAction !== null ? styles.disabledButton : null]}
      >
        {pendingAction === connectionAction ? (
          <ActivityIndicator color={colors.surface} size="small" />
        ) : null}
        <Text style={styles.primaryButtonText}>{connected ? "Disconnect" : "Connect"}</Text>
      </Pressable>

      {device.kind === "heart-rate" ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Forget ${device.name}`}
          accessibilityState={{
            busy: pendingAction === "forget",
            disabled: pendingAction !== null,
          }}
          disabled={pendingAction !== null}
          onPress={() => void runAction("forget")}
          style={[styles.secondaryButton, pendingAction !== null ? styles.disabledButton : null]}
        >
          <Text style={styles.secondaryButtonText}>Forget device</Text>
        </Pressable>
      ) : connected ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={
            device.connectionState === "streaming"
              ? "Stop WHOOP inertial measurement unit (IMU) streaming"
              : "Start WHOOP inertial measurement unit (IMU) streaming"
          }
          accessibilityState={{
            busy: pendingAction === "start-streaming" || pendingAction === "stop-streaming",
            disabled: pendingAction !== null,
          }}
          disabled={pendingAction !== null}
          onPress={() =>
            void runAction(
              device.connectionState === "streaming" ? "stop-streaming" : "start-streaming",
            )
          }
          style={[styles.secondaryButton, pendingAction !== null ? styles.disabledButton : null]}
        >
          <Text style={styles.streamingButtonText}>
            {device.connectionState === "streaming"
              ? "Stop inertial measurement unit (IMU) streaming"
              : "Start inertial measurement unit (IMU) streaming"}
          </Text>
        </Pressable>
      ) : null}
      {device.kind === "whoop" &&
        device.peripheralId &&
        device.managedHistoryEnabled !== undefined && (
          <Pressable
            accessibilityRole="switch"
            accessibilityLabel="Dofek-managed history"
            accessibilityState={{
              busy: pendingAction === "toggle-managed-history",
              disabled: pendingAction !== null,
              checked: device.managedHistoryEnabled,
            }}
            disabled={pendingAction !== null}
            onPress={handleManagedHistoryPress}
            style={[
              styles.secondaryButton,
              pendingAction === "toggle-managed-history" ? styles.disabledButton : null,
            ]}
          >
            <Text style={styles.streamingButtonText}>
              {device.managedHistoryEnabled ? "Disable" : "Enable"} Dofek-managed history
            </Text>
          </Pressable>
        )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.background,
    flex: 1,
  },
  content: {
    gap: spacing.md,
    padding: spacing.md,
    paddingBottom: spacing.xl,
  },
  stateContainer: {
    backgroundColor: colors.background,
    flex: 1,
    padding: spacing.md,
  },
  title: {
    color: colors.text,
    fontSize: fontSize.xl,
    fontWeight: fontWeight.bold,
  },
  connectionState: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    textTransform: "capitalize",
  },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.sm,
    padding: spacing.md,
  },
  cardTitle: {
    color: colors.textSecondary,
    fontSize: fontSize.xs,
    fontWeight: fontWeight.bold,
    textTransform: "uppercase",
  },
  batteryCard: {
    alignItems: "center",
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
  },
  batteryReadout: {
    maxWidth: "100%",
  },
  primaryDiagnostic: {
    color: colors.text,
    fontSize: fontSize.xl,
    fontWeight: fontWeight.bold,
  },
  diagnostic: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
  },
  primaryButton: {
    alignItems: "center",
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    flexDirection: "row",
    gap: spacing.sm,
    justifyContent: "center",
    padding: spacing.sm,
  },
  primaryButtonText: {
    color: colors.surface,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.bold,
  },
  secondaryButton: {
    alignItems: "center",
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.sm,
  },
  secondaryButtonText: {
    color: colors.danger,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.bold,
  },
  streamingButtonText: {
    color: colors.accent,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.bold,
  },
  disabledButton: {
    opacity: 0.6,
  },
});
