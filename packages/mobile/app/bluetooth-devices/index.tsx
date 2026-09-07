import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ScrollView, StyleSheet, Text } from "react-native";
import { BluetoothDeviceList } from "../../components/BluetoothDeviceList";
import {
  type BluetoothDevice,
  getBluetoothDevices,
  subscribeBluetoothDevices,
} from "../../lib/bluetooth-device-catalog";
import { captureException } from "../../lib/telemetry";
import { scanAndConnect } from "../../modules/ble-heart-rate";
import { colors, fontSize, fontWeight, spacing } from "../../theme";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function BluetoothDevicesScreen() {
  const router = useRouter();
  const mounted = useRef(true);
  const [devices, setDevices] = useState<BluetoothDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadDevices = useCallback(async () => {
    try {
      const nextDevices = await getBluetoothDevices();
      if (!mounted.current) return;
      setDevices(nextDevices);
      setError(null);
    } catch (loadError: unknown) {
      captureException(loadError, { source: "bluetooth-devices-load" });
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
          setError(update.error);
        }
      });
    } catch (subscriptionError: unknown) {
      captureException(subscriptionError, { source: "bluetooth-devices-subscribe" });
      setError(errorMessage(subscriptionError));
    }
    return () => {
      mounted.current = false;
      subscription?.remove();
    };
  }, []);

  useFocusEffect(
    useCallback(() => {
      void loadDevices();
    }, [loadDevices]),
  );

  const connectDevice = useCallback(async () => {
    setConnecting(true);
    setError(null);
    try {
      await scanAndConnect();
      await loadDevices();
    } catch (connectionError: unknown) {
      captureException(connectionError, { source: "bluetooth-devices-scan-and-connect" });
      if (mounted.current) {
        setError(errorMessage(connectionError));
      }
    } finally {
      if (mounted.current) {
        setConnecting(false);
      }
    }
  }, [loadDevices]);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Bluetooth Devices</Text>
      <Text style={styles.description}>
        Manage WHOOP and Bluetooth heart-rate monitors connected to this device.
      </Text>
      <BluetoothDeviceList
        connecting={connecting}
        devices={devices}
        error={error}
        loading={loading}
        onConnectDevice={() => void connectDevice()}
        onSelectDevice={(device) =>
          router.push(`/bluetooth-devices/${encodeURIComponent(device.id)}`)
        }
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.background,
    flex: 1,
  },
  content: {
    padding: spacing.md,
    paddingBottom: spacing.xl,
  },
  title: {
    color: colors.text,
    fontSize: fontSize.xl,
    fontWeight: fontWeight.bold,
    marginBottom: spacing.xs,
  },
  description: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    lineHeight: 20,
    marginBottom: spacing.lg,
  },
});
