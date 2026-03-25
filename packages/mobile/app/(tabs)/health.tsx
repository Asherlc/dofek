import { useCallback, useEffect, useState } from "react";
import { Alert, ScrollView, StyleSheet, Text, TouchableOpacity, View, useWindowDimensions } from "react-native";
import { useRouter } from "expo-router";
import { useAuth } from "../../lib/auth-context";
import { colors } from "../../theme";
import {
  enableBackgroundDelivery,
  getRequestStatus,
  isAvailable,
  isBackgroundDeliveryEnabled,
  queryDailyStatistics,
  queryQuantitySamples,
  querySleepSamples,
  queryWorkouts,
  requestPermissions,
} from "../../modules/health-kit";
import { trpc } from "../../lib/trpc";
import {
  ADDITIVE_QUANTITY_TYPES,
  NON_ADDITIVE_QUANTITY_TYPES,
  syncHealthKitToServer,
} from "../../lib/health-kit-sync";

interface SyncStatus {
  lastSync: Date | null;
  syncing: boolean;
  lastResult: string | null;
  progress: string | null;
}

const SYNC_RANGE_OPTIONS: Array<{ label: string; value: number | null }> = [
  { label: "7d", value: 7 },
  { label: "30d", value: 30 },
  { label: "90d", value: 90 },
  { label: "1y", value: 365 },
  { label: "All", value: null },
];

const HEALTHKIT_BACKFILL_COMPLETED_KEY = "healthkit_backfill_completed";

const ALL_QUANTITY_TYPES = [...ADDITIVE_QUANTITY_TYPES, ...NON_ADDITIVE_QUANTITY_TYPES];

const NAV_LINKS = [
  { route: "/sleep" as const, label: "Sleep", emoji: "\uD83C\uDF19", description: "Sleep stages, debt & patterns" },
  { route: "/correlation" as const, label: "Correlation Explorer", emoji: "\u{1F50D}", description: "See how any two metrics relate" },
  { route: "/accelerometer" as const, label: "Accelerometer", emoji: "\uD83D\uDCF1", description: "Raw motion data & recording status" },
  { route: "/providers" as const, label: "Data Sources", emoji: "\uD83D\uDD17", description: "Manage providers & sync history" },
  { route: "/tracking" as const, label: "Tracking", emoji: "\uD83D\uDCCB", description: "Life events" },
  { route: "/settings" as const, label: "Settings", emoji: "\u2699\uFE0F", description: "Accounts, units & export" },
];

export default function HealthScreen() {
  const router = useRouter();
  const { user, serverUrl, logout } = useAuth();
  const [permissionsGranted, setPermissionsGranted] = useState(false);
  const [backgroundEnabled, setBackgroundEnabled] = useState(() =>
    isAvailable() ? isBackgroundDeliveryEnabled() : false,
  );
  const [status, setStatus] = useState<SyncStatus>({
    lastSync: null,
    syncing: false,
    lastResult: null,
    progress: null,
  });

  const backfillSetting = trpc.settings.get.useQuery({ key: HEALTHKIT_BACKFILL_COMPLETED_KEY });
  const backfillCompleted = backfillSetting.data?.value === true;
  const [syncRange, setSyncRange] = useState<number | null | undefined>(undefined);

  // Resolve the effective sync range: user selection takes priority, then backfill status
  const effectiveSyncRange = syncRange !== undefined
    ? syncRange
    : backfillSetting.isLoading
      ? 7 // safe default while loading
      : backfillCompleted
        ? 7
        : null; // first time = All

  const trpcClient = trpc.useUtils().client;
  const setBackfillComplete = trpc.settings.set.useMutation();

  const available = isAvailable();

  useEffect(() => {
    if (!available) return;
    getRequestStatus()
      .then((status) => {
        if (status === "unnecessary") {
          setPermissionsGranted(true);
        }
      })
      .catch(() => {
        // Fall through — show Request Permissions button as fallback
      });
  }, [available]);

  async function handleRequestPermissions() {
    try {
      const granted = await requestPermissions();
      setPermissionsGranted(granted);
      if (!granted) {
        Alert.alert(
          "Permissions Required",
          "HealthKit permissions are needed to sync your health data. You can enable them in Settings > Privacy > Health.",
        );
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      Alert.alert("Error", message);
    }
  }

  const handleSync = useCallback(async () => {
    setStatus((prev) => ({ ...prev, syncing: true, lastResult: null, progress: null }));

    try {
      const result = await syncHealthKitToServer({
        trpcClient,
        healthKit: {
          queryDailyStatistics,
          queryQuantitySamples,
          queryWorkouts,
          querySleepSamples,
        },
        syncRangeDays: effectiveSyncRange,
        onProgress: (message) =>
          setStatus((prev) => ({ ...prev, progress: message })),
      });

      // Mark backfill as completed after successful all-time sync
      if (effectiveSyncRange === null) {
        await setBackfillComplete.mutateAsync({
          key: HEALTHKIT_BACKFILL_COMPLETED_KEY,
          value: true,
        });
      }

      const resultMessage = result.errors.length > 0
        ? `Synced ${result.inserted} records with ${result.errors.length} errors`
        : `Synced ${result.inserted} records`;

      setStatus({
        lastSync: new Date(),
        syncing: false,
        lastResult: resultMessage,
        progress: null,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus((prev) => ({
        ...prev,
        syncing: false,
        lastResult: `Error: ${message}`,
        progress: null,
      }));
    }
  }, [trpcClient, setBackfillComplete, effectiveSyncRange]);

  async function handleEnableBackground() {
    try {
      for (const typeId of ALL_QUANTITY_TYPES) {
        await enableBackgroundDelivery(typeId);
      }
      setBackgroundEnabled(true);
      Alert.alert("Background Sync", "Background delivery enabled for all health data types.");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      Alert.alert("Error", message);
    }
  }

  const { width } = useWindowDimensions();
  const isWide = width >= 600;

  return (
    <ScrollView style={styles.container} contentContainerStyle={[styles.content, isWide && styles.contentWide]}>
      {/* Navigation links */}
      {NAV_LINKS.map((link) => (
        <TouchableOpacity
          key={link.route}
          style={styles.navCard}
          onPress={() => router.push(link.route)}
          activeOpacity={0.7}
        >
          <Text style={styles.navEmoji}>{link.emoji}</Text>
          <View style={styles.navTextContainer}>
            <Text style={styles.navLabel}>{link.label}</Text>
            <Text style={styles.navDescription}>{link.description}</Text>
          </View>
          <Text style={styles.navChevron}>›</Text>
        </TouchableOpacity>
      ))}

      <Text style={[styles.title, { marginTop: 16 }]}>HealthKit Sync</Text>

      {!available ? (
        <View style={styles.card}>
          <Text style={styles.errorText}>HealthKit is not available on this device.</Text>
        </View>
      ) : (
        <>
          {/* Permissions */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Permissions</Text>
            <Text style={styles.cardDescription}>
              {permissionsGranted
                ? "HealthKit permissions granted."
                : "Grant access to sync heart rate, heart rate variability, steps, sleep, and other health data."}
            </Text>
            {!permissionsGranted && (
              <TouchableOpacity style={styles.button} onPress={handleRequestPermissions} activeOpacity={0.7}>
                <Text style={styles.buttonText}>Request Permissions</Text>
              </TouchableOpacity>
            )}
          </View>

          {/* Sync */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Manual Sync</Text>
            <Text style={styles.cardDescription}>
              {effectiveSyncRange === null
                ? "Sync all health data to the server."
                : `Sync the last ${effectiveSyncRange} days of health data to the server.`}
            </Text>
            <View style={styles.syncRangeRow}>
              {SYNC_RANGE_OPTIONS.map((opt) => (
                <TouchableOpacity
                  key={opt.label}
                  style={[
                    styles.syncRangeButton,
                    effectiveSyncRange === opt.value && styles.syncRangeButtonActive,
                  ]}
                  onPress={() => setSyncRange(opt.value)}
                  activeOpacity={0.7}
                >
                  <Text
                    style={[
                      styles.syncRangeText,
                      effectiveSyncRange === opt.value && styles.syncRangeTextActive,
                    ]}
                  >
                    {opt.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
            <TouchableOpacity
              style={[styles.button, status.syncing && styles.buttonDisabled]}
              onPress={handleSync}
              activeOpacity={0.7}
              disabled={status.syncing}
            >
              <Text style={styles.buttonText}>
                {status.syncing ? "Syncing..." : "Sync Now"}
              </Text>
            </TouchableOpacity>
          </View>

          {/* Status */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Status</Text>
            <View style={styles.statusRow}>
              <Text style={styles.statusLabel}>Last sync</Text>
              <Text style={styles.statusValue}>
                {status.lastSync
                  ? status.lastSync.toLocaleTimeString()
                  : "Never"}
              </Text>
            </View>
            {status.progress && (
              <View style={styles.statusRow}>
                <Text style={styles.statusLabel}>Progress</Text>
                <Text style={styles.statusValue}>{status.progress}</Text>
              </View>
            )}
            {status.lastResult && (
              <View style={styles.statusRow}>
                <Text style={styles.statusLabel}>Result</Text>
                <Text style={[styles.statusValue, status.lastResult.startsWith("Error") && styles.errorText]}>
                  {status.lastResult}
                </Text>
              </View>
            )}
          </View>

          {/* Background */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Background Sync</Text>
            <Text style={styles.cardDescription}>
              Enable background delivery so data syncs automatically.
            </Text>
            <TouchableOpacity
              style={[styles.buttonSecondary, backgroundEnabled && styles.buttonDisabled]}
              onPress={handleEnableBackground}
              activeOpacity={0.7}
              disabled={backgroundEnabled}
            >
              <Text style={styles.buttonSecondaryText}>
                {backgroundEnabled ? "Background Delivery Enabled" : "Enable Background Delivery"}
              </Text>
            </TouchableOpacity>
          </View>
        </>
      )}

      {/* Account */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Account</Text>
        {user ? (
          <View style={styles.statusRow}>
            <Text style={styles.statusLabel}>Signed in as</Text>
            <Text style={styles.statusValue}>{user.name}</Text>
          </View>
        ) : null}
        {serverUrl ? (
          <View style={styles.statusRow}>
            <Text style={styles.statusLabel}>Server</Text>
            <Text style={styles.statusValue} numberOfLines={1}>
              {serverUrl}
            </Text>
          </View>
        ) : null}
        <TouchableOpacity style={styles.buttonSecondary} onPress={logout} activeOpacity={0.7}>
          <Text style={styles.buttonSecondaryText}>Sign Out</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  content: {
    padding: 16,
    paddingTop: 24,
    paddingBottom: 40,
  },
  contentWide: {
    maxWidth: 600,
    alignSelf: "center",
    width: "100%",
  },
  title: {
    fontSize: 28,
    fontWeight: "800",
    color: colors.text,
    marginBottom: 16,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    padding: 16,
    marginBottom: 12,
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: colors.text,
    marginBottom: 4,
  },
  cardDescription: {
    fontSize: 14,
    color: colors.textSecondary,
    lineHeight: 20,
    marginBottom: 12,
  },
  button: {
    backgroundColor: colors.accent,
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: "center",
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonText: {
    color: colors.text,
    fontSize: 16,
    fontWeight: "600",
  },
  buttonSecondary: {
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.accent,
    alignItems: "center",
  },
  buttonSecondaryText: {
    color: colors.accent,
    fontSize: 16,
    fontWeight: "600",
  },
  statusRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.surfaceSecondary,
  },
  statusLabel: {
    fontSize: 15,
    color: colors.textSecondary,
  },
  statusValue: {
    fontSize: 15,
    color: colors.text,
  },
  syncRangeRow: {
    flexDirection: "row",
    gap: 6,
    marginBottom: 12,
  },
  syncRangeButton: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.surfaceSecondary,
  },
  syncRangeButtonActive: {
    backgroundColor: colors.surfaceSecondary,
    borderColor: colors.accent,
  },
  syncRangeText: {
    fontSize: 13,
    color: colors.textSecondary,
  },
  syncRangeTextActive: {
    color: colors.text,
    fontWeight: "600",
  },
  errorText: {
    color: colors.danger,
  },
  navCard: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    padding: 16,
    marginBottom: 8,
    flexDirection: "row",
    alignItems: "center",
  },
  navEmoji: {
    fontSize: 24,
    marginRight: 12,
  },
  navTextContainer: {
    flex: 1,
  },
  navLabel: {
    fontSize: 16,
    fontWeight: "700",
    color: colors.text,
  },
  navDescription: {
    fontSize: 13,
    color: colors.textSecondary,
    marginTop: 2,
  },
  navChevron: {
    fontSize: 24,
    color: colors.textTertiary,
    marginLeft: 8,
  },
});
