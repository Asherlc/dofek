import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import { Stack } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AuthProvider, useAuth } from "../lib/auth-context";
import { initBackgroundAccelerometerSync } from "../lib/background-accelerometer-sync";
import { initBackgroundHealthKitSync } from "../lib/background-health-kit-sync";
import { initBackgroundWatchInertialMeasurementUnitSync } from "../lib/background-watch-inertial-measurement-unit-sync";
import { syncWhoopBle, teardownBackgroundWhoopBleSync } from "../lib/background-whoop-ble-sync";
import type { SyncTrpcClient } from "../lib/health-kit-sync";
import { getTrpcUrl } from "../lib/server";
import { captureException, initTelemetry, logger } from "../lib/telemetry";
import { trpc } from "../lib/trpc";
import { useWhoopBleSync } from "../lib/useWhoopBleSync";
import { getVersionHeaders } from "../lib/version-headers";
import { addBackgroundRefreshListener, scheduleRefresh } from "../modules/background-refresh";
import {
  addConnectionStateListener as addWhoopConnectionStateListener,
  confirmRealtimeDataDrain as confirmWhoopRealtimeDataDrain,
  confirmSamplesDrain as confirmWhoopSamplesDrain,
  findWhoop,
  isBluetoothAvailable,
  peekBufferedRealtimeData as peekWhoopRealtimeData,
  peekBufferedSamples as peekWhoopSamples,
  startImuStreaming,
  stopImuStreaming,
  connect as whoopConnect,
  disconnect as whoopDisconnect,
} from "../modules/whoop-ble";
import { colors } from "../theme";
import LoginScreen from "./login";

initTelemetry();

export const rootStackScreenOptions = {
  headerStyle: { backgroundColor: colors.background },
  headerTintColor: colors.text,
  headerBackButtonDisplayMode: "minimal" as const,
  headerBackTitle: "Back",
  headerBackTitleVisible: false,
  headerShadowVisible: false,
  animation: "fade" as const,
};

/**
 * Headless component that manages WHOOP BLE accelerometer sync.
 * Must be rendered inside the tRPC provider tree so it can use tRPC query hooks.
 */
function WhoopBleSyncManager({ trpcClient }: { trpcClient: ReturnType<typeof trpc.createClient> }) {
  const whoopSyncClient = useMemo(
    () => ({
      inertialMeasurementUnitSync: {
        pushSamples: {
          mutate: (
            input: Parameters<typeof trpcClient.inertialMeasurementUnitSync.pushSamples.mutate>[0],
          ) => trpcClient.inertialMeasurementUnitSync.pushSamples.mutate(input),
        },
      },
    }),
    [trpcClient],
  );

  const whoopRealtimeClient = useMemo(
    () => ({
      whoopBleSync: {
        pushRealtimeData: {
          mutate: (input: Parameters<typeof trpcClient.whoopBleSync.pushRealtimeData.mutate>[0]) =>
            trpcClient.whoopBleSync.pushRealtimeData.mutate(input),
        },
      },
    }),
    [trpcClient],
  );

  const whoopDeps = useMemo(
    () => ({
      isBluetoothAvailable,
      findWhoop,
      connect: whoopConnect,
      startImuStreaming,
      stopImuStreaming,
      peekBufferedSamples: peekWhoopSamples,
      confirmSamplesDrain: confirmWhoopSamplesDrain,
      peekBufferedRealtimeData: peekWhoopRealtimeData,
      confirmRealtimeDataDrain: confirmWhoopRealtimeDataDrain,
      addConnectionStateListener: addWhoopConnectionStateListener,
      disconnect: whoopDisconnect,
    }),
    [],
  );

  useWhoopBleSync(whoopSyncClient, whoopDeps, whoopRealtimeClient);

  return null;
}

function AuthGate() {
  const { user, serverUrl, isLoading, sessionToken } = useAuth();

  const [queryClient] = useState(() => new QueryClient());

  const trpcClient = useMemo(() => {
    const url = getTrpcUrl(serverUrl);
    const versionHeaders = getVersionHeaders();
    return trpc.createClient({
      links: [
        httpBatchLink({
          url,
          methodOverride: "POST",
          headers: () => {
            const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
            const defaultHeaders = { ...versionHeaders, "x-timezone": timezone };
            return sessionToken
              ? { Authorization: `Bearer ${sessionToken}`, ...defaultHeaders }
              : defaultHeaders;
          },
        }),
      ],
    });
  }, [serverUrl, sessionToken]);

  // Set up background HealthKit sync when authenticated
  useEffect(() => {
    if (!user || !trpcClient) return;
    const syncClient: SyncTrpcClient = {
      healthKitSync: {
        pushQuantitySamples: {
          mutate: (input) => trpcClient.healthKitSync.pushQuantitySamples.mutate(input),
        },
        pushWorkouts: {
          mutate: (input) => trpcClient.healthKitSync.pushWorkouts.mutate(input),
        },
        pushWorkoutRoutes: {
          mutate: (input) => trpcClient.healthKitSync.pushWorkoutRoutes.mutate(input),
        },
        pushSleepSamples: {
          mutate: (input) => trpcClient.healthKitSync.pushSleepSamples.mutate(input),
        },
      },
    };
    initBackgroundHealthKitSync(syncClient, () => {
      queryClient.invalidateQueries();
    }).catch((error: unknown) => {
      logger.warn(
        "bg-healthkit-sync",
        `Init failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      captureException(error, { source: "bg-healthkit-sync" });
    });

    // Start continuous accelerometer recording and background sync
    const imuSyncClient = {
      inertialMeasurementUnitSync: {
        pushSamples: {
          mutate: (
            input: Parameters<typeof trpcClient.inertialMeasurementUnitSync.pushSamples.mutate>[0],
          ) => trpcClient.inertialMeasurementUnitSync.pushSamples.mutate(input),
        },
      },
    };
    initBackgroundAccelerometerSync(imuSyncClient).catch((error: unknown) => {
      // Best-effort — accelerometer sync is non-critical
      captureException(error, { source: "bg-accelerometer-sync" });
    });

    // Start Apple Watch IMU sync (if Watch is paired)
    initBackgroundWatchInertialMeasurementUnitSync(imuSyncClient).catch((error: unknown) => {
      // Best-effort — Watch sync is non-critical
      captureException(error, { source: "bg-watch-accel-sync" });
    });

    // WHOOP BLE sync is now managed reactively via useWhoopBleSync hook
    // inside the tRPC provider tree (see WhoopBleSyncManager below).

    // Listen for background refresh wakeups (~every 15-30 min, system-decided).
    // On each wake, restart Watch recording, sync IMU data, and
    // retry WHOOP BLE connection so coverage continues even if the user
    // never opens the app.
    const refreshSubscription = addBackgroundRefreshListener(() => {
      // Restart Watch IMU recording
      initBackgroundWatchInertialMeasurementUnitSync(imuSyncClient).catch((error: unknown) => {
        captureException(error, { source: "bg-refresh-watch-sync" });
      });

      // Restart phone accelerometer recording
      initBackgroundAccelerometerSync(imuSyncClient).catch((error: unknown) => {
        captureException(error, { source: "bg-refresh-accel-sync" });
      });

      // Retry WHOOP BLE connection and flush buffered IMU samples
      import("../modules/whoop-ble")
        .then(({ retryConnection }) => {
          retryConnection().catch((error: unknown) => {
            captureException(error, { source: "bg-refresh-whoop-retry" });
          });
        })
        .catch((error: unknown) => {
          captureException(error, { source: "bg-refresh-whoop-import" });
        });

      // Upload any WHOOP BLE samples buffered since last sync
      const whoopRealtimeSyncClient = {
        whoopBleSync: {
          pushRealtimeData: {
            mutate: (
              input: Parameters<typeof trpcClient.whoopBleSync.pushRealtimeData.mutate>[0],
            ) => trpcClient.whoopBleSync.pushRealtimeData.mutate(input),
          },
        },
      };
      syncWhoopBle(
        imuSyncClient,
        {
          isBluetoothAvailable,
          findWhoop,
          connect: whoopConnect,
          startImuStreaming,
          stopImuStreaming,
          peekBufferedSamples: peekWhoopSamples,
          confirmSamplesDrain: confirmWhoopSamplesDrain,
          peekBufferedRealtimeData: peekWhoopRealtimeData,
          confirmRealtimeDataDrain: confirmWhoopRealtimeDataDrain,
          addConnectionStateListener: addWhoopConnectionStateListener,
          disconnect: whoopDisconnect,
        },
        whoopRealtimeSyncClient,
      ).catch((error: unknown) => {
        captureException(error, { source: "bg-refresh-whoop-flush" });
      });

      // Re-schedule for next wakeup
      scheduleRefresh();
    });

    return () => {
      teardownBackgroundWhoopBleSync();
      refreshSubscription.remove();
    };
  }, [user, trpcClient, queryClient]);

  if (isLoading) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color={colors.accent} size="large" />
      </View>
    );
  }

  // No user — show login
  if (!user) {
    return <LoginScreen />;
  }

  // Step 3: Authenticated — show the app
  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <WhoopBleSyncManager trpcClient={trpcClient} />
        <Stack screenOptions={rootStackScreenOptions}>
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen
            name="food/add"
            options={({ navigation }) => ({
              presentation: "fullScreenModal",
              title: "Add Food",
              headerStyle: { backgroundColor: colors.background },
              headerTintColor: colors.text,
              headerLeft: () => (
                <Pressable onPress={() => navigation.goBack()}>
                  <Text style={{ color: colors.accent, fontSize: 17 }}>Cancel</Text>
                </Pressable>
              ),
            })}
          />
          <Stack.Screen
            name="providers"
            options={{
              headerShown: false,
            }}
          />
          <Stack.Screen
            name="settings"
            options={{
              title: "Settings",
            }}
          />
          <Stack.Screen
            name="nutrition-analytics"
            options={{
              title: "Nutrition Analytics",
            }}
          />
          <Stack.Screen
            name="supplements"
            options={{
              title: "Supplements",
            }}
          />
          <Stack.Screen
            name="sleep"
            options={{
              title: "Sleep",
            }}
          />
          <Stack.Screen
            name="activity/[id]"
            options={{
              title: "Activity",
            }}
          />
          <Stack.Screen
            name="activities"
            options={{
              title: "Activities",
              headerStyle: { backgroundColor: colors.background },
              headerTintColor: colors.text,
            }}
          />
          <Stack.Screen
            name="correlation"
            options={{
              title: "Correlation Explorer",
            }}
          />
          <Stack.Screen
            name="ble-probe"
            options={{
              title: "BLE Probe",
            }}
          />
          <Stack.Screen
            name="preview"
            options={{
              title: "Preview Update",
            }}
          />
        </Stack>
      </QueryClientProvider>
    </trpc.Provider>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <AuthGate />
      </AuthProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    backgroundColor: colors.background,
    justifyContent: "center",
    alignItems: "center",
  },
});
