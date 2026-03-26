import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { Stack } from "expo-router";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { trpc } from "../lib/trpc";
import { AuthProvider, useAuth } from "../lib/auth-context";
import { initBackgroundAccelerometerSync } from "../lib/background-accelerometer-sync";
import { initBackgroundHealthKitSync } from "../lib/background-health-kit-sync";
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
    }).catch(() => {
      // Best-effort — don't block the app for background sync setup failures
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
