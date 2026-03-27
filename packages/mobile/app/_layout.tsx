import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { Stack } from "expo-router";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { trpc } from "../lib/trpc";
import { AuthProvider, useAuth } from "../lib/auth-context";
import { initBackgroundAccelerometerSync } from "../lib/background-accelerometer-sync";
import {
  initBackgroundHealthKitSync,
} from "../lib/background-health-kit-sync";
import { captureException, logger } from "../lib/telemetry";
import { initBackgroundWatchAccelerometerSync } from "../lib/background-watch-accelerometer-sync";
import {
  initBackgroundWhoopBleSync,
  teardownBackgroundWhoopBleSync,
} from "../lib/background-whoop-ble-sync";
import {
  addBackgroundRefreshListener,
  scheduleRefresh,
} from "../modules/background-refresh";
import {
  isBluetoothAvailable,
  findWhoop,
  connect as whoopConnect,
  startImuStreaming,
  stopImuStreaming,
  getBufferedSamples as getWhoopSamples,
  disconnect as whoopDisconnect,
} from "../modules/whoop-ble";
import type { SyncTrpcClient } from "../lib/health-kit-sync";
import { getTrpcUrl } from "../lib/server";
import { initTelemetry } from "../lib/telemetry";
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
};

function AuthGate() {
  const { user, serverUrl, isLoading, sessionToken } = useAuth();

  const [queryClient] = useState(() => new QueryClient());

  const trpcClient = useMemo(() => {
    const url = getTrpcUrl(serverUrl);
    return trpc.createClient({
      links: [
        httpBatchLink({
          url,
          methodOverride: "POST",
          headers: () => {
            const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
            return sessionToken
              ? { Authorization: `Bearer ${sessionToken}`, "x-timezone": tz }
              : { "x-timezone": tz };
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
        pushSleepSamples: {
          mutate: (input) => trpcClient.healthKitSync.pushSleepSamples.mutate(input),
        },
      },
    };
    initBackgroundHealthKitSync(syncClient, () => {
      queryClient.invalidateQueries();
    }).catch((error: unknown) => {
      logger.warn("bg-healthkit-sync", `Init failed: ${error instanceof Error ? error.message : String(error)}`);
      captureException(error, { source: "bg-healthkit-sync" });
    });

    // Start continuous accelerometer recording and background sync
    initBackgroundAccelerometerSync({
      accelerometerSync: {
        pushAccelerometerSamples: {
          mutate: (input) =>
            trpcClient.accelerometerSync.pushAccelerometerSamples.mutate(input),
        },
      },
    }).catch(() => {
      // Best-effort — accelerometer sync is non-critical
    });

    // Start Apple Watch accelerometer sync (if Watch is paired)
    const watchSyncClient = {
      accelerometerSync: {
        pushAccelerometerSamples: {
          mutate: (input: Parameters<typeof trpcClient.accelerometerSync.pushAccelerometerSamples.mutate>[0]) =>
            trpcClient.accelerometerSync.pushAccelerometerSamples.mutate(input),
        },
      },
    };
    initBackgroundWatchAccelerometerSync(watchSyncClient).catch(() => {
      // Best-effort — Watch sync is non-critical
    });

    // Start always-on WHOOP BLE accelerometer sync (if enabled in settings)
    trpcClient.settings.get.query({ key: "whoopAlwaysOnImu" }).then((setting) => {
      if (setting?.value !== true) return;

      const whoopSyncClient = {
        accelerometerSync: {
          pushAccelerometerSamples: {
            mutate: (input: Parameters<typeof trpcClient.accelerometerSync.pushAccelerometerSamples.mutate>[0]) =>
              trpcClient.accelerometerSync.pushAccelerometerSamples.mutate(input),
          },
        },
      };

      initBackgroundWhoopBleSync(whoopSyncClient, {
        isBluetoothAvailable,
        findWhoop,
        connect: whoopConnect,
        startImuStreaming,
        stopImuStreaming,
        getBufferedSamples: getWhoopSamples,
        disconnect: whoopDisconnect,
      }).catch(() => {
        // Best-effort — WHOOP BLE sync is non-critical
      });
    }).catch(() => {
      // Best-effort — settings fetch failure is non-critical
    });

    // Listen for background refresh wakeups (~every 15-30 min, system-decided).
    // On each wake, restart Watch recording and sync accelerometer data so
    // coverage continues even if the user never opens the app.
    const refreshSubscription = addBackgroundRefreshListener(() => {
      // Restart Watch accelerometer recording
      initBackgroundWatchAccelerometerSync(watchSyncClient).catch(() => {});

      // Restart phone accelerometer recording
      initBackgroundAccelerometerSync({
        accelerometerSync: {
          pushAccelerometerSamples: {
            mutate: (input) =>
              trpcClient.accelerometerSync.pushAccelerometerSamples.mutate(input),
          },
        },
      }).catch(() => {});

      // Re-schedule for next wakeup
      scheduleRefresh();
    });

    return () => {
      teardownBackgroundWhoopBleSync();
      refreshSubscription.remove();
    };
  }, [user, trpcClient]);

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
        <Stack
          screenOptions={rootStackScreenOptions}
        >
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
                  <Text style={{ color: colors.accent, fontSize: 17 }}>
                    Cancel
                  </Text>
                </Pressable>
              ),
            })}
          />
          <Stack.Screen
            name="providers"
            options={{
              title: "Data Sources",
            }}
          />
          <Stack.Screen
            name="settings"
            options={{
              title: "Settings",
            }}
          />
          <Stack.Screen
            name="tracking"
            options={{
              title: "Tracking",
            }}
          />
          <Stack.Screen
            name="training"
            options={{
              title: "Training",
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
            name="insights"
            options={{
              title: "Insights",
            }}
          />
          <Stack.Screen
            name="providers/[id]"
            options={{
              title: "Provider Detail",
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
            name="predictions"
            options={{
              title: "Predictions",
            }}
          />
          <Stack.Screen
            name="correlation"
            options={{
              title: "Correlation Explorer",
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
