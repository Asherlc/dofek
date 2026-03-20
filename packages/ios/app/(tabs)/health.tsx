import { useCallback, useState } from "react";
import { Alert, ScrollView, StyleSheet, Text, TouchableOpacity, View, useWindowDimensions } from "react-native";
import { useRouter } from "expo-router";
import { useAuth } from "../../lib/auth-context";
import { colors } from "../../theme";
import {
  enableBackgroundDelivery,
  isAvailable,
  queryQuantitySamples,
  querySleepSamples,
  type WorkoutSample,
  queryWorkouts,
  requestPermissions,
} from "../../modules/health-kit";
import { trpc } from "../../lib/trpc";

interface SyncStatus {
  lastSync: Date | null;
  syncing: boolean;
  lastResult: string | null;
}

const QUANTITY_TYPES = [
  "HKQuantityTypeIdentifierBodyMass",
  "HKQuantityTypeIdentifierBodyFatPercentage",
  "HKQuantityTypeIdentifierHeartRate",
  "HKQuantityTypeIdentifierRestingHeartRate",
  "HKQuantityTypeIdentifierHeartRateVariabilitySDNN",
  "HKQuantityTypeIdentifierStepCount",
  "HKQuantityTypeIdentifierActiveEnergyBurned",
  "HKQuantityTypeIdentifierBasalEnergyBurned",
  "HKQuantityTypeIdentifierDistanceWalkingRunning",
  "HKQuantityTypeIdentifierFlightsClimbed",
  "HKQuantityTypeIdentifierAppleExerciseTime",
  "HKQuantityTypeIdentifierVO2Max",
  "HKQuantityTypeIdentifierOxygenSaturation",
  "HKQuantityTypeIdentifierRespiratoryRate",
];

function daysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

function normalizeWorkoutsForSync(workouts: WorkoutSample[]): WorkoutSample[] {
  return workouts.map((workout) => ({
    ...workout,
    totalEnergyBurned: workout.totalEnergyBurned ?? null,
    totalDistance: workout.totalDistance ?? null,
  }));
}

const NAV_LINKS = [
  { route: "/correlation" as const, label: "Correlation Explorer", emoji: "\u{1F50D}", description: "See how any two metrics relate" },
  { route: "/training" as const, label: "Training", emoji: "\u{1F3CB}\u{FE0F}", description: "Performance, endurance & recovery" },
  { route: "/providers" as const, label: "Data Sources", emoji: "🔗", description: "Manage providers & sync history" },
  { route: "/tracking" as const, label: "Tracking", emoji: "📋", description: "Life events & supplements" },
  { route: "/settings" as const, label: "Settings", emoji: "⚙️", description: "Accounts, units & export" },
];

export default function HealthScreen() {
  const router = useRouter();
  const { user, serverUrl, logout } = useAuth();
  const [permissionsGranted, setPermissionsGranted] = useState(false);
  const [status, setStatus] = useState<SyncStatus>({
    lastSync: null,
    syncing: false,
    lastResult: null,
  });

  const pushQuantity = trpc.healthKitSync.pushQuantitySamples.useMutation();
  const pushWorkouts = trpc.healthKitSync.pushWorkouts.useMutation();
  const pushSleep = trpc.healthKitSync.pushSleepSamples.useMutation();

  const available = isAvailable();

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
    setStatus((prev) => ({ ...prev, syncing: true, lastResult: null }));

    try {
      const startDate = daysAgo(7);
      const endDate = new Date().toISOString();

      // Sync quantity samples
      const allSamples = [];
      for (const typeId of QUANTITY_TYPES) {
        const samples = await queryQuantitySamples(typeId, startDate, endDate);
        allSamples.push(...samples);
      }

      let totalInserted = 0;
      const errors: string[] = [];

      if (allSamples.length > 0) {
        // Push in batches of 500
        for (let i = 0; i < allSamples.length; i += 500) {
          const batch = allSamples.slice(i, i + 500);
          const result = await pushQuantity.mutateAsync({ samples: batch });
          totalInserted += result.inserted;
          errors.push(...result.errors);
        }
      }

      // Sync workouts
      const workouts = normalizeWorkoutsForSync(await queryWorkouts(startDate, endDate));
      if (workouts.length > 0) {
        const result = await pushWorkouts.mutateAsync({ workouts });
        totalInserted += result.inserted;
      }

      // Sync sleep
      const sleepSamples = await querySleepSamples(startDate, endDate);
      if (sleepSamples.length > 0) {
        const result = await pushSleep.mutateAsync({ samples: sleepSamples });
        totalInserted += result.inserted;
      }

      const resultMessage = errors.length > 0
        ? `Synced ${totalInserted} records with ${errors.length} errors`
        : `Synced ${totalInserted} records`;

      setStatus({
        lastSync: new Date(),
        syncing: false,
        lastResult: resultMessage,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus((prev) => ({
        ...prev,
        syncing: false,
        lastResult: `Error: ${message}`,
      }));
    }
  }, [pushQuantity, pushWorkouts, pushSleep]);

  async function handleEnableBackground() {
    try {
      for (const typeId of QUANTITY_TYPES) {
        await enableBackgroundDelivery(typeId);
      }
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
              Sync the last 7 days of health data to the server.
            </Text>
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
            <TouchableOpacity style={styles.buttonSecondary} onPress={handleEnableBackground} activeOpacity={0.7}>
              <Text style={styles.buttonSecondaryText}>Enable Background Delivery</Text>
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
