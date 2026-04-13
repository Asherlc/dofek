import { Stack } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { WristModel } from "../components/WristModel";
import type { OrientationEvent } from "../modules/whoop-ble";
import {
  addConnectionStateListener,
  addOrientationListener,
  connect,
  findWhoop,
  getConnectionState,
  startImuStreaming,
} from "../modules/whoop-ble";
import { colors } from "../theme";
import { rootStackScreenOptions } from "./_layout";

type ConnectionStatus = "disconnected" | "searching" | "connecting" | "streaming" | "error";

function formatDegrees(degrees: number): string {
  return `${degrees >= 0 ? "+" : ""}${degrees.toFixed(1)}°`;
}

/**
 * Check whether the native BLE module is already connected.
 * Background WHOOP BLE sync may have established the connection before
 * this screen opened — no need to connect again.
 */
function isAlreadyConnected(): boolean {
  const state = getConnectionState();
  return state === "streaming" || state === "ready";
}

export default function ImuVisualizationScreen() {
  const [status, setStatus] = useState<ConnectionStatus>(() =>
    isAlreadyConnected() ? "streaming" : "disconnected",
  );
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
  const updateCountRef = useRef(0);
  const rateIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  // Subscribe to orientation events — fires at ~30 Hz when IMU is streaming,
  // regardless of whether this screen or background sync started the stream.
  useEffect(() => {
    const subscription = addOrientationListener((event) => {
      setOrientation(event);
      updateCountRef.current += 1;
    });

    return () => subscription.remove();
  }, []);

  const ensureConnected = useCallback(async () => {
    // Already connected via background sync — IMU should already be streaming
    if (isAlreadyConnected()) {
      // Best-effort: ensure IMU mode is on (background sync should have done this)
      try {
        await startImuStreaming();
      } catch {
        // Ignore — background sync likely already started it
      }
      setStatus("streaming");
      return;
    }

    try {
      setError(null);
      setStatus("searching");
      const device = await findWhoop();
      if (!device) {
        setError("No WHOOP strap found. Make sure BLE sync is enabled in settings.");
        setStatus("error");
        return;
      }

      setStatus("connecting");
      await connect(device.id);
      await startImuStreaming();
      setStatus("streaming");
    } catch (connectionError) {
      setError(
        connectionError instanceof Error ? connectionError.message : String(connectionError),
      );
      setStatus("error");
    }
  }, []);

  // Auto-connect on mount, listen for BLE state changes
  useEffect(() => {
    ensureConnected();

    const subscription = addConnectionStateListener((event) => {
      if (event.state === "connected") {
        setStatus("streaming");
      } else if (event.state === "disconnected") {
        setStatus("disconnected");
        // Clear any pending reconnect before scheduling a new one
        if (reconnectTimerRef.current) {
          clearTimeout(reconnectTimerRef.current);
        }
        reconnectTimerRef.current = setTimeout(() => {
          reconnectTimerRef.current = null;
          ensureConnected();
        }, 2000);
      }
    });

    return () => {
      subscription.remove();
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };
  }, [ensureConnected]);

  const isStreaming = status === "streaming";

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
});
