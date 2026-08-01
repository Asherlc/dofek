import * as Sentry from "@sentry/react-native";
import { httpBatchLink, httpLink, splitLink } from "@trpc/client";
import * as Notifications from "expo-notifications";
import { Stack, usePathname, useRouter } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AuthProvider, useAuth } from "../lib/auth-context";
import {
  initBackgroundAccelerometerSync,
  teardownBackgroundAccelerometerSync,
} from "../lib/background-accelerometer-sync";
import {
  initBackgroundHealthKitSync,
  teardownBackgroundHealthKitSync,
} from "../lib/background-health-kit-sync";
import { runRequiredBackgroundRefreshWork } from "../lib/background-refresh-work";
import {
  createWatchSyncClient,
  initBackgroundWatchInertialMeasurementUnitSync,
  teardownBackgroundWatchInertialMeasurementUnitSync,
} from "../lib/background-watch-inertial-measurement-unit-sync";
import { syncWhoopBle, teardownBackgroundWhoopBleSync } from "../lib/background-whoop-ble-sync";
import type { SyncTrpcClient } from "../lib/health-kit-sync";
import { invalidateSyncedHealthData } from "../lib/invalidate-synced-health-data";
import { resolveMedicationReminderNotificationPath } from "../lib/medication-reminder-notifications";
import { MobileQueryPersistenceProvider } from "../lib/mobile-query-persistence";
import { createAppQueryClient } from "../lib/query-client";
import { runAfterUiIdle } from "../lib/runAfterUiIdle";
import { getTrpcUrl } from "../lib/server";
import {
  finishStartupPhase,
  markAppInteractive,
  startStartupPhase,
  startStartupTelemetry,
} from "../lib/startup-telemetry";
import { captureException, initTelemetry, logger, setTelemetryRoute } from "../lib/telemetry";
import { trpc } from "../lib/trpc";
import { createTrpcFetch } from "../lib/trpc-fetch";
import { useWhoopBleSync } from "../lib/useWhoopBleSync";
import { getVersionHeaders } from "../lib/version-headers";
import { addBackgroundRefreshListener } from "../modules/background-refresh";
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
import { rootStackScreenOptions } from "./_layout-options";
import LoginScreen from "./login";

try {
  initTelemetry();
} catch (error: unknown) {
  captureException(error, { source: "bootstrap-telemetry-init", route: "/bootstrap" });
}

try {
  startStartupTelemetry();
} catch (error: unknown) {
  captureException(error, { source: "startup-telemetry-init", route: "/bootstrap" });
}

SplashScreen.preventAutoHideAsync().catch((error: unknown) => {
  captureException(error, { source: "splash-screen-prevent-auto-hide", route: "/splash" });
});

/**
 * Headless component that manages WHOOP BLE accelerometer sync.
 * Must be rendered inside the tRPC provider tree so it can use tRPC query hooks.
 */
function MedicationReminderNotificationListener() {
  const router = useRouter();

  useEffect(() => {
    const navigateFromNotificationData = (data: unknown) => {
      const path = resolveMedicationReminderNotificationPath(data);
      if (!path) return;
      router.push(path);
    };

    try {
      const lastResponse = Notifications.getLastNotificationResponse();
      if (lastResponse) {
        navigateFromNotificationData(lastResponse.notification.request.content.data);
      }
    } catch (error: unknown) {
      captureException(error, { context: "medication-reminder-notification-last-response" });
    }

    const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
      try {
        navigateFromNotificationData(response.notification.request.content.data);
      } catch (error: unknown) {
        captureException(error, { context: "medication-reminder-notification-response" });
      }
    });

    return () => {
      subscription.remove();
    };
  }, [router]);

  return null;
}

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

function TelemetryRouteSync({
  isAuthenticated,
  isLoading,
}: {
  isAuthenticated: boolean;
  isLoading: boolean;
}) {
  const pathname = usePathname();
  const telemetryRoute = isLoading || isAuthenticated ? pathname : "/login";

  useEffect(() => {
    setTelemetryRoute(telemetryRoute);
  }, [telemetryRoute]);

  return null;
}

function AuthGate() {
  const { user, serverUrl, isLoading, sessionToken, bootstrapError, logout, retryBootstrap } =
    useAuth();
  const [backgroundSyncReady, setBackgroundSyncReady] = useState(false);
  const startupInteractiveMarkedRef = useRef(false);

  const [queryClient] = useState(createAppQueryClient);

  useEffect(() => {
    finishStartupPhase("javascript", "ready");
  }, []);

  const trpcClient = useMemo(() => {
    const url = getTrpcUrl(serverUrl);
    const versionHeaders = getVersionHeaders();
    const commonOptions = {
      url,
      fetch: createTrpcFetch(),
      methodOverride: "POST" as const,
      headers: () => {
        const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        const defaultHeaders = { ...versionHeaders, "x-timezone": timezone };
        return sessionToken
          ? { Authorization: `Bearer ${sessionToken}`, ...defaultHeaders }
          : defaultHeaders;
      },
    };

    const batchLink = httpBatchLink(commonOptions);
    const dashboardQueryLink = httpLink(commonOptions);

    return trpc.createClient({
      links: [
        splitLink({
          condition: (operation) => operation.type === "mutation",
          true: batchLink,
          false: splitLink({
            condition: (operation) =>
              operation.type === "query" &&
              (operation.path === "mobileDashboard.dashboard" ||
                operation.path === "mobileDashboard.dashboardV2" ||
                operation.path === "mobileDashboard.recovery" ||
                operation.path === "mobileDashboard.training"),
            true: dashboardQueryLink,
            false: batchLink,
          }),
        }),
      ],
    });
  }, [serverUrl, sessionToken]);

  useEffect(() => {
    if (!user?.id) return;
    return () => {
      queryClient.clear();
    };
  }, [queryClient, user?.id]);

  useEffect(() => {
    if (user) return;
    queryClient.clear();
  }, [queryClient, user]);

  useEffect(() => {
    if (isLoading || startupInteractiveMarkedRef.current) return;

    startupInteractiveMarkedRef.current = true;
    startStartupPhase("splash-hide");
    SplashScreen.hideAsync()
      .then(() => {
        markAppInteractive({ serviceBootstrapExpected: Boolean(user) });
      })
      .catch((error: unknown) => {
        captureException(error, { source: "splash-screen-hide" });
        markAppInteractive({
          serviceBootstrapExpected: Boolean(user),
          outcome: "error",
        });
      });
  }, [isLoading, user]);

  useEffect(() => {
    if (!user) {
      setBackgroundSyncReady(false);
      return;
    }

    setBackgroundSyncReady(false);
    const idleHandle = runAfterUiIdle(() => {
      setBackgroundSyncReady(true);
    });

    return () => {
      idleHandle.cancel();
      setBackgroundSyncReady(false);
    };
  }, [user]);

  // Set up background HealthKit sync when authenticated
  useEffect(() => {
    if (!user || !trpcClient || !backgroundSyncReady) return;
    startStartupPhase("service-bootstrap");
    let serviceBootstrapFailed = false;
    const syncClient: SyncTrpcClient = {
      healthKitSync: {
        deleteQuantitySamples: {
          mutate: (input) => trpcClient.healthKitSync.deleteQuantitySamples.mutate(input),
        },
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
    const healthKitBootstrap = initBackgroundHealthKitSync(syncClient, () => {
      return invalidateSyncedHealthData(queryClient);
    }).catch((error: unknown) => {
      serviceBootstrapFailed = true;
      logger.warn(
        "bg-healthkit-sync",
        `Init failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      captureException(error, { source: "bg-healthkit-sync" });
    });

    // Start continuous accelerometer recording and background sync
    const imuSyncClient = createWatchSyncClient(trpcClient);
    const accelerometerBootstrap = initBackgroundAccelerometerSync(imuSyncClient).catch(
      (error: unknown) => {
        serviceBootstrapFailed = true;
        // Best-effort — accelerometer sync is non-critical
        captureException(error, { source: "bg-accelerometer-sync" });
      },
    );

    // Start Apple Watch IMU sync (if Watch is paired)
    const watchBootstrap = initBackgroundWatchInertialMeasurementUnitSync(imuSyncClient).catch(
      (error: unknown) => {
        serviceBootstrapFailed = true;
        // Best-effort — Watch sync is non-critical
        captureException(error, { source: "bg-watch-sync" });
      },
    );

    void Promise.all([healthKitBootstrap, accelerometerBootstrap, watchBootstrap])
      .then(() => {
        finishStartupPhase("service-bootstrap", serviceBootstrapFailed ? "error" : "ready");
      })
      .catch((error: unknown) => {
        captureException(error, { source: "startup-service-bootstrap-telemetry" });
        finishStartupPhase("service-bootstrap", "error");
      });

    // WHOOP BLE sync is now managed reactively via useWhoopBleSync hook
    // inside the tRPC provider tree (see WhoopBleSyncManager below).

    // Listen for background refresh wakeups (~every 15-30 min, system-decided).
    // On each wake, restart Watch recording, sync IMU data, and
    // retry WHOOP BLE connection so coverage continues even if the user
    // never opens the app.
    const refreshSubscription = addBackgroundRefreshListener(() => {
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
      return runRequiredBackgroundRefreshWork([
        {
          source: "bg-refresh-watch-sync",
          run: () => initBackgroundWatchInertialMeasurementUnitSync(imuSyncClient),
        },
        {
          source: "bg-refresh-accel-sync",
          run: () => initBackgroundAccelerometerSync(imuSyncClient),
        },
        {
          source: "bg-refresh-whoop-retry",
          run: async () => {
            const { retryConnection } = await import("../modules/whoop-ble");
            await retryConnection();
          },
        },
        {
          source: "bg-refresh-whoop-flush",
          run: () =>
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
            ),
        },
      ]);
    });

    return () => {
      teardownBackgroundHealthKitSync();
      teardownBackgroundAccelerometerSync();
      teardownBackgroundWatchInertialMeasurementUnitSync();
      teardownBackgroundWhoopBleSync();
      refreshSubscription.remove();
    };
  }, [user, trpcClient, queryClient, backgroundSyncReady]);

  if (isLoading) {
    return (
      <>
        <TelemetryRouteSync isAuthenticated={Boolean(user)} isLoading />
        <View style={styles.loading}>
          <ActivityIndicator color={colors.accent} size="large" />
        </View>
      </>
    );
  }

  if (bootstrapError) {
    return (
      <>
        <TelemetryRouteSync isAuthenticated={Boolean(user)} isLoading={false} />
        <View style={styles.authError}>
          <Text style={styles.authErrorTitle}>Could not verify your session</Text>
          <Text style={styles.authErrorMessage}>{bootstrapError}</Text>
          <View style={styles.authErrorActions}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Try again"
              style={styles.authErrorButton}
              onPress={retryBootstrap}
            >
              <Text style={styles.authErrorButtonText}>Try again</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Sign out"
              style={[styles.authErrorButton, styles.authErrorSecondaryButton]}
              onPress={logout}
            >
              <Text style={[styles.authErrorButtonText, styles.authErrorSecondaryButtonText]}>
                Sign out
              </Text>
            </Pressable>
          </View>
        </View>
      </>
    );
  }

  // No user — show login
  if (!user) {
    return (
      <>
        <TelemetryRouteSync isAuthenticated={false} isLoading={false} />
        <LoginScreen />
      </>
    );
  }

  // Step 3: Authenticated — show the app
  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <TelemetryRouteSync isAuthenticated isLoading={false} />
      <MobileQueryPersistenceProvider key={user.id} queryClient={queryClient} userId={user.id}>
        {backgroundSyncReady && <WhoopBleSyncManager trpcClient={trpcClient} />}
        <MedicationReminderNotificationListener />
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
                <Pressable
                  onPress={() => navigation.goBack()}
                  accessibilityRole="button"
                  accessibilityLabel="Cancel adding food"
                >
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
            name="alerts"
            options={{
              title: "Alerts",
            }}
          />
          <Stack.Screen
            name="reports"
            options={{
              title: "Health Reports",
            }}
          />
          <Stack.Screen
            name="more"
            options={{
              title: "More",
            }}
          />
          <Stack.Screen
            name="support"
            options={{
              title: "Help & Support",
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
            name="breathwork"
            options={{
              title: "Breathwork",
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
            name="behavior-associations"
            options={{
              title: "Behavior Associations",
            }}
          />
          <Stack.Screen
            name="tracking"
            options={{
              title: "Journal Trends",
            }}
          />
          <Stack.Screen
            name="experiments"
            options={{
              title: "Personal Experiments",
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
      </MobileQueryPersistenceProvider>
    </trpc.Provider>
  );
}

function RootLayout() {
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <AuthGate />
      </AuthProvider>
    </SafeAreaProvider>
  );
}

export default Sentry.wrap(RootLayout);

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    backgroundColor: colors.background,
    justifyContent: "center",
    alignItems: "center",
  },
  authError: {
    flex: 1,
    backgroundColor: colors.background,
    justifyContent: "center",
    padding: 24,
  },
  authErrorTitle: {
    color: colors.text,
    fontSize: 20,
    fontWeight: "700",
    marginBottom: 8,
  },
  authErrorMessage: {
    color: colors.danger,
    fontSize: 15,
    lineHeight: 22,
  },
  authErrorActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12,
    marginTop: 20,
  },
  authErrorButton: {
    alignItems: "center",
    backgroundColor: colors.accent,
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  authErrorSecondaryButton: {
    backgroundColor: "transparent",
    borderColor: colors.danger,
    borderWidth: 1,
  },
  authErrorButtonText: {
    color: colors.textInverse,
    fontSize: 16,
    fontWeight: "700",
  },
  authErrorSecondaryButtonText: {
    color: colors.danger,
  },
});
