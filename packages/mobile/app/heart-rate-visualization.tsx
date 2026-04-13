import { Stack } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { HeartRateChart } from "../components/charts/HeartRateChart";
import { captureException } from "../lib/telemetry";
import {
  addConnectionStateListener,
  connect,
  findWhoop,
  getConnectionState,
  isBluetoothAvailable,
  peekBufferedRealtimeData,
  startRealtimeHr,
} from "../modules/whoop-ble";
import { colors } from "../theme";
import { rootStackScreenOptions } from "./_layout";

type ConnectionStatus = "disconnected" | "searching" | "connecting" | "streaming" | "error";

/** Maximum number of HR samples to keep in the rolling window */
const MAX_SAMPLES = 120;
/** How often to poll the BLE buffer (ms) */
const POLL_INTERVAL_MS = 1000;

/**
 * Check whether the native BLE module is already connected and streaming.
 * Background WHOOP BLE sync may have established the connection before
 * this screen opened — no need to connect again.
 */
function isAlreadyStreaming(): boolean {
  const state = getConnectionState();
  return state === "streaming" || state === "ready";
}

export default function HeartRateVisualizationScreen() {
  const [status, setStatus] = useState<ConnectionStatus>(() =>
    isAlreadyStreaming() ? "streaming" : "disconnected",
  );
  const [error, setError] = useState<string | null>(null);
  const [heartRateHistory, setHeartRateHistory] = useState<number[]>([]);
  const [currentHeartRate, setCurrentHeartRate] = useState<number | null>(null);
  const [currentRrInterval, setCurrentRrInterval] = useState<number | null>(null);
  const [sampleCount, setSampleCount] = useState(0);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastSeenTimestampRef = useRef<string | null>(null);

  const stopPolling = useCallback(() => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
  }, []);

  const startPolling = useCallback(() => {
    stopPolling();
    pollIntervalRef.current = setInterval(async () => {
      try {
        // Peek without draining — background sync handles the drain cycle.
        const samples = await peekBufferedRealtimeData();
        if (samples.length === 0) return;

        // Only process samples we haven't seen yet (by timestamp).
        const cutoff = lastSeenTimestampRef.current;
        const newSamples = cutoff ? samples.filter((sample) => sample.timestamp > cutoff) : samples;
        if (newSamples.length === 0) return;

        lastSeenTimestampRef.current = newSamples[newSamples.length - 1].timestamp;

        const newHeartRates = newSamples
          .map((sample) => sample.heartRate)
          .filter((heartRate) => heartRate > 0);

        if (newHeartRates.length === 0) return;

        const latestSample = newSamples[newSamples.length - 1];
        setCurrentHeartRate(latestSample.heartRate);
        if (latestSample.rrIntervalMs > 0) {
          setCurrentRrInterval(latestSample.rrIntervalMs);
        }

        setSampleCount((previous) => previous + newSamples.length);
        setHeartRateHistory((previous) => [...previous, ...newHeartRates].slice(-MAX_SAMPLES));
      } catch (pollError) {
        captureException(pollError, { context: "heart-rate-visualization-poll" });
      }
    }, POLL_INTERVAL_MS);
  }, [stopPolling]);

  const ensureConnected = useCallback(async () => {
    // Already connected via background sync — just ensure HR streaming is on
    if (isAlreadyStreaming()) {
      try {
        await startRealtimeHr();
      } catch {
        // Best-effort — passive HR data may still flow
      }
      setStatus("streaming");
      startPolling();
      return;
    }

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
        setError("No WHOOP strap found. Make sure BLE sync is enabled in settings.");
        setStatus("error");
        return;
      }

      setStatus("connecting");
      await connect(device.id);
      await startRealtimeHr();
      setStatus("streaming");
      startPolling();
    } catch (connectionError) {
      setError(
        connectionError instanceof Error ? connectionError.message : String(connectionError),
      );
      setStatus("error");
    }
  }, [startPolling]);

  // Auto-connect on mount, listen for BLE state changes
  useEffect(() => {
    ensureConnected();

    // If background sync reconnects while this screen is open, resume polling
    const subscription = addConnectionStateListener((event) => {
      if (event.state === "connected" || event.state === "streaming") {
        if (!pollIntervalRef.current) {
          setStatus("streaming");
          startPolling();
        }
      } else if (event.state === "disconnected") {
        setStatus("disconnected");
        stopPolling();
        // Try to reconnect after a short delay
        setTimeout(() => ensureConnected(), 2000);
      }
    });

    return () => {
      subscription.remove();
      stopPolling();
    };
  }, [ensureConnected, startPolling, stopPolling]);

  const isStreaming = status === "streaming";

  return (
    <>
      <Stack.Screen options={{ ...rootStackScreenOptions, title: "Heart Rate" }} />
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        {/* Current HR */}
        <View style={styles.heroContainer}>
          <Text style={styles.heroLabel}>Heart Rate</Text>
          <View style={styles.heroRow}>
            <Text style={styles.heroValue}>
              {currentHeartRate != null ? currentHeartRate : "--"}
            </Text>
            <Text style={styles.heroUnit}>bpm</Text>
          </View>
          {currentRrInterval != null && (
            <Text style={styles.rrText}>R-R: {currentRrInterval} ms</Text>
          )}
        </View>

        {/* Live Chart */}
        <View style={styles.chartContainer}>
          {heartRateHistory.length >= 2 ? (
            <HeartRateChart data={heartRateHistory} height={200} />
          ) : (
            <View style={styles.chartPlaceholder}>
              <Text style={styles.chartPlaceholderText}>
                {isStreaming ? "Waiting for data..." : "Connecting to WHOOP..."}
              </Text>
            </View>
          )}
        </View>

        {/* Stats */}
        {heartRateHistory.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Session</Text>
            <View style={styles.statsRow}>
              <View style={styles.statBox}>
                <Text style={styles.statLabel}>Min</Text>
                <Text style={styles.statValue}>{Math.min(...heartRateHistory)}</Text>
              </View>
              <View style={styles.statBox}>
                <Text style={styles.statLabel}>Avg</Text>
                <Text style={styles.statValue}>
                  {Math.round(
                    heartRateHistory.reduce((sum, value) => sum + value, 0) /
                      heartRateHistory.length,
                  )}
                </Text>
              </View>
              <View style={styles.statBox}>
                <Text style={styles.statLabel}>Max</Text>
                <Text style={styles.statValue}>{Math.max(...heartRateHistory)}</Text>
              </View>
              <View style={styles.statBox}>
                <Text style={styles.statLabel}>Samples</Text>
                <Text style={styles.statValue}>{sampleCount}</Text>
              </View>
            </View>
          </View>
        )}

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
          {error && <Text style={styles.errorText}>{error}</Text>}
        </View>
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { paddingBottom: 40 },
  heroContainer: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 24,
    backgroundColor: colors.surface,
    marginHorizontal: 16,
    marginTop: 16,
    borderRadius: 16,
  },
  heroLabel: {
    fontSize: 14,
    fontWeight: "600",
    color: colors.textSecondary,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  heroRow: {
    flexDirection: "row",
    alignItems: "baseline",
    marginTop: 4,
  },
  heroValue: {
    fontSize: 64,
    fontWeight: "800",
    color: colors.danger,
    fontVariant: ["tabular-nums"],
  },
  heroUnit: {
    fontSize: 20,
    fontWeight: "600",
    color: colors.textSecondary,
    marginLeft: 4,
  },
  rrText: {
    fontSize: 14,
    color: colors.textSecondary,
    marginTop: 4,
    fontVariant: ["tabular-nums"],
  },
  chartContainer: {
    marginHorizontal: 16,
    marginTop: 12,
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: 12,
    height: 224,
  },
  chartPlaceholder: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  chartPlaceholderText: {
    fontSize: 14,
    color: colors.textSecondary,
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
  statsRow: { flexDirection: "row", gap: 8 },
  statBox: {
    flex: 1,
    alignItems: "center",
    paddingVertical: 8,
    backgroundColor: colors.background,
    borderRadius: 8,
  },
  statLabel: { fontSize: 12, fontWeight: "600", color: colors.textSecondary, marginBottom: 4 },
  statValue: {
    fontSize: 20,
    fontWeight: "700",
    color: colors.text,
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
