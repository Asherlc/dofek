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
import { trpc } from "../lib/trpc";
import {
  getMotionAuthorizationStatus,
  isAccelerometerRecordingAvailable,
  isRecordingActive,
  type MotionAuthorizationStatus,
  requestMotionPermission,
} from "../modules/core-motion";
import { getWatchSyncStatus } from "../modules/watch-motion";
import { isBluetoothAvailable } from "../modules/whoop-ble";
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
      .catch(() => {
        // Best-effort — re-read the status in case it changed
        refreshStatus();
      });
  }, [status, refreshStatus]);

  // Re-read permission when the app returns to foreground (the iOS
  // permission dialog causes a background→active transition)
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

export default function AccelerometerScreen() {
  const available = isAccelerometerRecordingAvailable();
  const recording = available && isRecordingActive();
  const authStatus = useMotionPermission(available);
  const watchStatus = getWatchSyncStatus();
  const bluetoothAvailable = isBluetoothAvailable();

  const syncStatus = trpc.accelerometer.getSyncStatus.useQuery();
  const dailyCounts = trpc.accelerometer.getDailyCounts.useQuery({ days: 30 });

  const whoopImuSetting = trpc.settings.get.useQuery({ key: "whoopAlwaysOnImu" });
  const setSettingMutation = trpc.settings.set.useMutation();
  const whoopImuEnabled = whoopImuSetting.data?.value === true;

  function handleWhoopImuToggle(enabled: boolean) {
    setSettingMutation.mutate(
      { key: "whoopAlwaysOnImu", value: enabled },
      { onSuccess: () => whoopImuSetting.refetch() },
    );
  }

  const whoopDevice = syncStatus.data?.find((device) => device.device_type === "whoop");

  const latestSync = syncStatus.data?.[0]?.latest_sample
    ? new Date(syncStatus.data[0].latest_sample).toLocaleString()
    : "Never";

  return (
    <>
      <Stack.Screen options={{ ...rootStackScreenOptions, title: "Motion Tracking" }} />
      <ScrollView style={styles.container}>
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
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>WHOOP Strap</Text>
          <Text style={styles.sectionDescription}>
            Streams motion data from your WHOOP strap via Bluetooth. Reduces strap battery life
            from ~5 days to ~3–4 days.
          </Text>
          <View style={styles.badgeRow}>
            <StatusBadge
              label="Bluetooth"
              value={bluetoothAvailable ? "On" : "Off"}
              color={bluetoothAvailable ? colors.positive : colors.textTertiary}
            />
            <StatusBadge
              label="Data"
              value={whoopDevice ? `${whoopDevice.sample_count.toLocaleString()}` : "None"}
              color={whoopDevice ? colors.positive : colors.textTertiary}
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
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Data Sources</Text>
          <View style={styles.statRow}>
            <Text style={styles.statLabel}>Last updated</Text>
            <Text style={styles.statValue}>{latestSync}</Text>
          </View>
          {syncStatus.data?.map((device) => (
            <View key={`${device.device_id}-${device.device_type}`} style={styles.statRow}>
              <Text style={styles.statLabel}>
                {deviceLabel(device.device_type, device.device_id)}
              </Text>
              <Text style={styles.statValue}>{device.sample_count.toLocaleString()} samples</Text>
            </View>
          ))}
          {(!syncStatus.data || syncStatus.data.length === 0) && (
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
                    { width: `${Math.min(day.hours_covered / 24, 1) * 100}%` },
                  ]}
                />
              </View>
              <Text style={styles.coverageHours}>{day.hours_covered.toFixed(1)}h</Text>
            </View>
          ))}
          {(!dailyCounts.data || dailyCounts.data.length === 0) && (
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
});
