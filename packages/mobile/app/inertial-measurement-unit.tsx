import { Stack } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import {
  AppState,
  type AppStateStatus,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";
import { captureException } from "../lib/telemetry";
import { trpc } from "../lib/trpc";
import {
  getMotionAuthorizationStatus,
  isAccelerometerRecordingAvailable,
  isRecordingActive,
  type MotionAuthorizationStatus,
  requestMotionPermission,
} from "../modules/core-motion";
import { getWatchSyncStatus } from "../modules/watch-motion";
import {
  getBluetoothState,
  getBufferedSampleCount,
  getConnectionState,
} from "../modules/whoop-ble";
import { colors } from "../theme";
import { rootStackScreenOptions } from "./_layout";

function StatusBadge({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <View style={styles.badge}>
      <Text style={styles.badgeLabel}>{label}</Text>
      <Text style={[styles.badgeValue, { color }]}>{value}</Text>
    </View>
  );
}

/** Map raw device_type from the server to a user-friendly label */
function deviceLabel(deviceType: string, deviceId: string): string {
  switch (deviceType) {
    case "iphone":
      return "iPhone";
    case "apple_watch":
      return "Apple Watch";
    case "whoop":
      return "WHOOP Strap";
    default:
      return deviceId;
  }
}

function useMotionPermission(available: boolean): MotionAuthorizationStatus | "unavailable" {
  const [status, setStatus] = useState<MotionAuthorizationStatus | "unavailable">(() =>
    available ? getMotionAuthorizationStatus() : "unavailable",
  );

  const refreshStatus = useCallback(() => {
    if (!available) return;
    setStatus(getMotionAuthorizationStatus());
  }, [available]);

  // Request permission on mount if not yet determined
  useEffect(() => {
    if (status !== "notDetermined") return;
    requestMotionPermission()
      .then((result) => {
        setStatus(result);
      })
      .catch((error: unknown) => {
        // Best-effort — re-read the status in case it changed
        captureException(error, { source: "accelerometer-motion-permission" });
        refreshStatus();
      });
  }, [status, refreshStatus]);

  // Re-read permission when the app returns to foreground (the iOS
  // permission dialog causes a background->active transition)
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState: AppStateStatus) => {
      if (nextState === "active") {
        refreshStatus();
      }
    });
    return () => subscription.remove();
  }, [refreshStatus]);

  return status;
}

function StatusWarning({ message }: { message: string }) {
  return (
    <View style={styles.warningRow}>
      <Text style={styles.warningText}>{message}</Text>
    </View>
  );
}

function getRecordingWarning(
  available: boolean,
  authStatus: string,
  recording: boolean,
): string | null {
  if (!available) return "Accelerometer recording is not available on this device.";
  if (authStatus === "denied")
    return "Motion permission denied. Go to Settings \u2192 Dofek \u2192 Motion & Fitness to enable.";
  if (authStatus === "restricted") return "Motion access is restricted by device management.";
  if (authStatus === "notDetermined")
    return "Motion permission not yet requested. Reopen the app to trigger the prompt.";
  if (!recording) return "Recording not active. Try closing and reopening the app.";
  return null;
}

function getWatchWarning(watchStatus: {
  isPaired: boolean;
  isWatchAppInstalled: boolean;
  isReachable: boolean;
  pendingFileCount: number;
}): string | null {
  if (!watchStatus.isPaired) return "No Apple Watch paired with this iPhone.";
  if (!watchStatus.isWatchAppInstalled)
    return "Install the Dofek Watch app from the Watch app on your iPhone.";
  if (watchStatus.pendingFileCount > 10)
    return `${watchStatus.pendingFileCount} files pending transfer. Data may be delayed.`;
  return null;
}

function getWhoopWarning(bleState: string, connectionState: string): string | null {
  if (bleState === "uninitialized")
    return "Bluetooth not initialized. Enable WHOOP always-on recording in Settings.";
  if (bleState === "poweredOff")
    return "Bluetooth is turned off. Enable it in Control Center or Settings.";
  if (bleState === "unauthorized")
    return "Bluetooth permission denied. Go to Settings \u2192 Dofek \u2192 Bluetooth to enable.";
  if (bleState === "unsupported") return "Bluetooth Low Energy is not supported on this device.";
  if (bleState !== "poweredOn" && bleState !== "uninitialized")
    return `Bluetooth state: ${bleState}. Waiting for Bluetooth to be ready.`;
  if (connectionState === "idle" && bleState === "poweredOn")
    return "Not connected to WHOOP strap. Make sure the WHOOP app is running and the strap is nearby.";
  if (connectionState === "scanning") return "Scanning for WHOOP strap...";
  if (connectionState === "connecting") return "Connecting to WHOOP strap...";
  if (connectionState === "discoveringServices") return "Discovering WHOOP services...";
  if (connectionState === "ready")
    return "Connected but not streaming. IMU streaming may not have started.";
  return null;
}

export default function InertialMeasurementUnitScreen() {
  const available = isAccelerometerRecordingAvailable();
  const recording = available && isRecordingActive();
  const authStatus = useMotionPermission(available);

  // Poll all native device statuses every 3s for live updates
  const [watchStatus, setWatchStatus] = useState(getWatchSyncStatus);
  const [whoopBleState, setWhoopBleState] = useState(getConnectionState);
  const [bleState, setBleState] = useState(getBluetoothState);
  const [whoopBuffered, setWhoopBuffered] = useState(0);

  useEffect(() => {
    const refresh = () => {
      setWatchStatus(getWatchSyncStatus());
      setWhoopBleState(getConnectionState());
      setBleState(getBluetoothState());
      setWhoopBuffered(getBufferedSampleCount());
    };
    refresh();
    const interval = setInterval(refresh, 3000);
    return () => clearInterval(interval);
  }, []);

  const syncStatus = trpc.inertialMeasurementUnit.getSyncStatus.useQuery();
  const dailyCounts = trpc.inertialMeasurementUnit.getDailyCounts.useQuery({ days: 30 });

  const trpcUtils = trpc.useUtils();
  const whoopImuSetting = trpc.settings.get.useQuery({ key: "whoopAlwaysOnImu" });
  const setSettingMutation = trpc.settings.set.useMutation();
  const whoopImuEnabled = whoopImuSetting.data?.value === true;

  function handleWhoopImuToggle(enabled: boolean) {
    trpcUtils.settings.get.setData(
      { key: "whoopAlwaysOnImu" },
      { key: "whoopAlwaysOnImu", value: enabled },
    );
    setSettingMutation.mutate(
      { key: "whoopAlwaysOnImu", value: enabled },
      {
        onSuccess: () => whoopImuSetting.refetch(),
        onError: () => whoopImuSetting.refetch(),
      },
    );
  }

  const whoopDevice = syncStatus.data?.find((device) => device.deviceType === "whoop");

  const latestSync = syncStatus.data?.[0]?.latestSample
    ? new Date(syncStatus.data[0].latestSample).toLocaleString()
    : "Never";

  // Collect all active problems for the top-level banner
  const problems: string[] = [];
  const recordingWarning = getRecordingWarning(available, authStatus, recording);
  if (recordingWarning) problems.push(`iPhone: ${recordingWarning}`);
  const watchWarning = getWatchWarning(watchStatus);
  if (watchWarning) problems.push(`Watch: ${watchWarning}`);
  if (whoopImuEnabled) {
    const whoopWarning = getWhoopWarning(bleState, whoopBleState);
    if (whoopWarning) problems.push(`WHOOP: ${whoopWarning}`);
  }

  const noDataSources =
    !recording && !watchStatus.isWatchAppInstalled && whoopBleState !== "streaming";

  return (
    <>
      <Stack.Screen options={{ ...rootStackScreenOptions, title: "Motion Tracking" }} />
      <ScrollView style={styles.container}>
        {problems.length > 0 && (
          <View style={styles.errorBanner}>
            <Text style={styles.errorBannerTitle}>
              {noDataSources ? "No active data sources" : "Issues detected"}
            </Text>
            {problems.map((problem) => (
              <Text key={problem} style={styles.errorBannerItem}>
                {`\u2022 ${problem}`}
              </Text>
            ))}
          </View>
        )}

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>iPhone</Text>
          <Text style={styles.sectionDescription}>
            Records motion data from your phone's sensors.
          </Text>
          <View style={styles.badgeRow}>
            <StatusBadge
              label="Available"
              value={available ? "Yes" : "No"}
              color={available ? colors.positive : colors.negative}
            />
            <StatusBadge
              label="Permission"
              value={authStatus === "authorized" ? "Granted" : authStatus}
              color={authStatus === "authorized" ? colors.positive : colors.negative}
            />
            <StatusBadge
              label="Recording"
              value={recording ? "Active" : "Inactive"}
              color={recording ? colors.positive : colors.textTertiary}
            />
          </View>
          {recordingWarning && <StatusWarning message={recordingWarning} />}
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Apple Watch</Text>
          <Text style={styles.sectionDescription}>
            Records motion data from your wrist for better accuracy.
          </Text>
          <View style={styles.badgeRow}>
            <StatusBadge
              label="Paired"
              value={watchStatus.isPaired ? "Yes" : "No"}
              color={watchStatus.isPaired ? colors.positive : colors.textTertiary}
            />
            <StatusBadge
              label="App Installed"
              value={watchStatus.isWatchAppInstalled ? "Yes" : "No"}
              color={watchStatus.isWatchAppInstalled ? colors.positive : colors.textTertiary}
            />
            <StatusBadge
              label="Pending"
              value={String(watchStatus.pendingFileCount)}
              color={watchStatus.pendingFileCount > 0 ? colors.accent : colors.textTertiary}
            />
          </View>
          {watchWarning && <StatusWarning message={watchWarning} />}
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>WHOOP Strap</Text>
          <Text style={styles.sectionDescription}>
            Streams motion data from your WHOOP strap via Bluetooth. Reduces strap battery life from
            ~5 days to ~3–4 days.
          </Text>
          <View style={styles.badgeRow}>
            <StatusBadge
              label="Bluetooth"
              value={bleState === "poweredOn" ? "On" : bleState}
              color={bleState === "poweredOn" ? colors.positive : colors.negative}
            />
            <StatusBadge
              label="Connection"
              value={whoopBleState}
              color={
                whoopBleState === "streaming"
                  ? colors.positive
                  : whoopBleState === "ready"
                    ? colors.accent
                    : colors.textTertiary
              }
            />
            <StatusBadge
              label="Buffered"
              value={
                whoopBuffered > 0
                  ? String(whoopBuffered)
                  : whoopDevice
                    ? `${whoopDevice.sampleCount.toLocaleString()}`
                    : "0"
              }
              color={
                whoopBuffered > 0
                  ? colors.accent
                  : whoopDevice
                    ? colors.positive
                    : colors.textTertiary
              }
            />
          </View>
          <View style={styles.toggleRow}>
            <View style={styles.toggleInfo}>
              <Text style={styles.toggleLabel}>Always-on recording</Text>
              <Text style={styles.toggleDescription}>
                Streams motion data whenever the app is open
              </Text>
            </View>
            <Switch
              value={whoopImuEnabled}
              onValueChange={handleWhoopImuToggle}
              disabled={setSettingMutation.isPending}
              trackColor={{ false: colors.surfaceSecondary, true: colors.accent }}
            />
          </View>
          {(() => {
            const warning = whoopImuEnabled ? getWhoopWarning(bleState, whoopBleState) : null;
            return warning ? <StatusWarning message={warning} /> : null;
          })()}
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Data Sources</Text>
          <View style={styles.statRow}>
            <Text style={styles.statLabel}>Last updated</Text>
            <Text style={styles.statValue}>{latestSync}</Text>
          </View>
          {syncStatus.data?.map((device) => (
            <View key={`${device.deviceId}-${device.deviceType}`} style={styles.statRow}>
              <Text style={styles.statLabel}>
                {deviceLabel(device.deviceType, device.deviceId)}
              </Text>
              <Text style={styles.statValue}>{device.sampleCount.toLocaleString()} samples</Text>
            </View>
          ))}
          {syncStatus.isError && <Text style={styles.errorText}>Failed to load motion data.</Text>}
          {!syncStatus.isError && (!syncStatus.data || syncStatus.data.length === 0) && (
            <Text style={styles.emptyText}>No motion data recorded yet</Text>
          )}
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Daily Coverage</Text>
          <Text style={styles.sectionDescription}>
            Hours of motion data recorded per day over the last 30 days.
          </Text>
          {dailyCounts.data?.map((day) => (
            <View key={day.date} style={styles.coverageRow}>
              <Text style={styles.coverageDate}>{day.date}</Text>
              <View style={styles.coverageBarContainer}>
                <View
                  style={[
                    styles.coverageBar,
                    { width: `${Math.min(day.hoursCovered / 24, 1) * 100}%` },
                  ]}
                />
              </View>
              <Text style={styles.coverageHours}>{day.hoursCovered.toFixed(1)}h</Text>
            </View>
          ))}
          {dailyCounts.isError && (
            <Text style={styles.errorText}>Failed to load daily coverage data.</Text>
          )}
          {!dailyCounts.isError && (!dailyCounts.data || dailyCounts.data.length === 0) && (
            <Text style={styles.emptyText}>No data yet</Text>
          )}
        </View>
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  section: { padding: 16, borderBottomWidth: 1, borderBottomColor: colors.border },
  sectionTitle: { fontSize: 18, fontWeight: "700", color: colors.text, marginBottom: 4 },
  sectionDescription: {
    fontSize: 13,
    color: colors.textSecondary,
    marginBottom: 12,
    lineHeight: 18,
  },
  badgeRow: { flexDirection: "row", gap: 12 },
  badge: {
    flex: 1,
    backgroundColor: colors.surface,
    borderRadius: 8,
    padding: 12,
    alignItems: "center",
  },
  badgeLabel: { fontSize: 12, color: colors.textSecondary, marginBottom: 4 },
  badgeValue: { fontSize: 14, fontWeight: "600" },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 12,
    backgroundColor: colors.surface,
    borderRadius: 8,
    padding: 12,
  },
  toggleInfo: { flex: 1, marginRight: 12 },
  toggleLabel: { fontSize: 14, fontWeight: "600", color: colors.text },
  toggleDescription: { fontSize: 12, color: colors.textSecondary, marginTop: 2 },
  statRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  statLabel: { fontSize: 14, color: colors.textSecondary },
  statValue: { fontSize: 14, fontWeight: "600", color: colors.text },
  coverageRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 4 },
  coverageDate: { width: 90, fontSize: 12, color: colors.textSecondary },
  coverageBarContainer: {
    flex: 1,
    height: 12,
    backgroundColor: colors.surface,
    borderRadius: 6,
    overflow: "hidden",
  },
  coverageBar: { height: "100%", backgroundColor: colors.accent, borderRadius: 6 },
  coverageHours: { width: 40, fontSize: 12, color: colors.textSecondary, textAlign: "right" },
  emptyText: { color: colors.textTertiary, textAlign: "center", paddingVertical: 16 },
  errorText: { color: colors.negative, textAlign: "center", paddingVertical: 16 },
  warningRow: {
    marginTop: 10,
    backgroundColor: `${colors.negative}15`,
    borderRadius: 8,
    padding: 10,
    borderLeftWidth: 3,
    borderLeftColor: colors.negative,
  },
  warningText: { fontSize: 13, color: colors.negative, lineHeight: 18 },
  errorBanner: {
    margin: 16,
    marginBottom: 0,
    backgroundColor: `${colors.negative}18`,
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: `${colors.negative}40`,
  },
  errorBannerTitle: {
    fontSize: 15,
    fontWeight: "700",
    color: colors.negative,
    marginBottom: 6,
  },
  errorBannerItem: {
    fontSize: 13,
    color: colors.negative,
    lineHeight: 20,
    paddingLeft: 4,
  },
});
