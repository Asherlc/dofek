import { Stack } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { WristModel } from "../components/WristModel";
import type { OrientationEvent } from "../modules/whoop-ble";
import {
  addOrientationListener,
  connect,
  disconnect,
  findWhoop,
  isBluetoothAvailable,
  startImuStreaming,
  stopImuStreaming,
} from "../modules/whoop-ble";
import { colors } from "../theme";
import { rootStackScreenOptions } from "./_layout";

type ConnectionStatus =
  | "disconnected"
  | "searching"
  | "connecting"
  | "connected"
  | "streaming"
  | "error";

function formatDegrees(degrees: number): string {
  return `${degrees >= 0 ? "+" : ""}${degrees.toFixed(1)}°`;
}

export default function ImuVisualizationScreen() {
  const [status, setStatus] = useState<ConnectionStatus>("disconnected");
  const [error, setError] = useState<string | null>(null);
  const [orientation, setOrientation] = useState<OrientationEvent>({
    w: 1,
    x: 0,
    y: 0,
    z: 0,
    roll: 0,
    pitch: 0,
    yaw: 0,
  });
  const [updateRate, setUpdateRate] = useState(0);
  const peripheralIdRef = useRef<string | null>(null);
  const updateCountRef = useRef(0);
  const rateIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Track update rate
  useEffect(() => {
    rateIntervalRef.current = setInterval(() => {
      setUpdateRate(updateCountRef.current);
      updateCountRef.current = 0;
    }, 1000);

    return () => {
      if (rateIntervalRef.current) {
        clearInterval(rateIntervalRef.current);
      }
    };
  }, []);

  // Subscribe to orientation events
  useEffect(() => {
    const subscription = addOrientationListener((event) => {
      setOrientation(event);
      updateCountRef.current += 1;
    });

    return () => subscription.remove();
  }, []);

  const handleStart = async () => {
    try {
      setError(null);

      if (!isBluetoothAvailable()) {
        setError("Bluetooth is not available");
        setStatus("error");
        return;
      }

      setStatus("searching");
      const device = await findWhoop();
      if (!device) {
        setError("No WHOOP strap found. Make sure the WHOOP app is connected.");
        setStatus("error");
        return;
      }

      setStatus("connecting");
      peripheralIdRef.current = device.id;
      await connect(device.id);

      setStatus("connected");
      await startImuStreaming();
      setStatus("streaming");
    } catch (connectionError) {
      setError(
        connectionError instanceof Error ? connectionError.message : String(connectionError),
      );
      setStatus("error");
    }
  };

  const handleStop = async () => {
    try {
      await stopImuStreaming();
      disconnect();
      peripheralIdRef.current = null;
      setStatus("disconnected");
      setUpdateRate(0);
      updateCountRef.current = 0;
    } catch {
      // Ignore stop errors — we're tearing down anyway
      setStatus("disconnected");
    }
  };

  const isStreaming = status === "streaming";
  const isBusy = status === "searching" || status === "connecting" || status === "connected";

  return (
    <>
      <Stack.Screen options={{ ...rootStackScreenOptions, title: "IMU Visualization" }} />
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        {/* 3D Model */}
        <View style={styles.modelContainer}>
          <WristModel orientation={orientation} size={280} />
        </View>

        {/* Euler Angles */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Orientation</Text>
          <View style={styles.anglesRow}>
            <View style={styles.angleBox}>
              <Text style={[styles.angleLabel, { color: colors.danger }]}>Roll (X)</Text>
              <Text style={styles.angleValue}>{formatDegrees(orientation.roll)}</Text>
            </View>
            <View style={styles.angleBox}>
              <Text style={[styles.angleLabel, { color: colors.green }]}>Pitch (Y)</Text>
              <Text style={styles.angleValue}>{formatDegrees(orientation.pitch)}</Text>
            </View>
            <View style={styles.angleBox}>
              <Text style={[styles.angleLabel, { color: colors.blue }]}>Yaw (Z)</Text>
              <Text style={styles.angleValue}>{formatDegrees(orientation.yaw)}</Text>
            </View>
          </View>
        </View>

        {/* Quaternion */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Quaternion</Text>
          <View style={styles.quaternionRow}>
            <Text style={styles.quaternionLabel}>w={orientation.w.toFixed(3)}</Text>
            <Text style={styles.quaternionLabel}>x={orientation.x.toFixed(3)}</Text>
            <Text style={styles.quaternionLabel}>y={orientation.y.toFixed(3)}</Text>
            <Text style={styles.quaternionLabel}>z={orientation.z.toFixed(3)}</Text>
          </View>
        </View>

        {/* Status */}
        <View style={styles.section}>
          <View style={styles.statusRow}>
            <Text style={styles.statusLabel}>Status</Text>
            <Text
              style={[
                styles.statusValue,
                {
                  color: isStreaming ? colors.positive : colors.textSecondary,
                },
              ]}
            >
              {status}
            </Text>
          </View>
          {isStreaming && (
            <View style={styles.statusRow}>
              <Text style={styles.statusLabel}>Update rate</Text>
              <Text style={styles.statusValue}>{updateRate} Hz</Text>
            </View>
          )}
          {error && <Text style={styles.errorText}>{error}</Text>}
        </View>

        {/* Controls */}
        <View style={styles.controls}>
          {!isStreaming ? (
            <Pressable
              style={[styles.button, isBusy && styles.buttonDisabled]}
              onPress={handleStart}
              disabled={isBusy}
            >
              <Text style={styles.buttonText}>{isBusy ? "Connecting..." : "Start Streaming"}</Text>
            </Pressable>
          ) : (
            <Pressable style={[styles.button, styles.buttonStop]} onPress={handleStop}>
              <Text style={styles.buttonText}>Stop</Text>
            </Pressable>
          )}
        </View>
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { paddingBottom: 40 },
  modelContainer: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 24,
    backgroundColor: colors.surface,
    marginHorizontal: 16,
    marginTop: 16,
    borderRadius: 16,
  },
  section: {
    padding: 16,
    marginHorizontal: 16,
    marginTop: 12,
    backgroundColor: colors.surface,
    borderRadius: 12,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: "600",
    color: colors.textSecondary,
    marginBottom: 8,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  anglesRow: { flexDirection: "row", gap: 8 },
  angleBox: {
    flex: 1,
    alignItems: "center",
    paddingVertical: 8,
    backgroundColor: colors.background,
    borderRadius: 8,
  },
  angleLabel: { fontSize: 12, fontWeight: "600", marginBottom: 4 },
  angleValue: {
    fontSize: 20,
    fontWeight: "700",
    color: colors.text,
    fontVariant: ["tabular-nums"],
  },
  quaternionRow: { flexDirection: "row", justifyContent: "space-between" },
  quaternionLabel: {
    fontSize: 14,
    color: colors.textSecondary,
    fontVariant: ["tabular-nums"],
  },
  statusRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 4,
  },
  statusLabel: { fontSize: 14, color: colors.textSecondary },
  statusValue: { fontSize: 14, fontWeight: "600", color: colors.text },
  errorText: { color: colors.danger, fontSize: 13, marginTop: 8 },
  controls: { padding: 16 },
  button: {
    backgroundColor: colors.accent,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: "center",
  },
  buttonDisabled: { opacity: 0.5 },
  buttonStop: { backgroundColor: colors.danger },
  buttonText: { color: "#fff", fontSize: 16, fontWeight: "700" },
});
