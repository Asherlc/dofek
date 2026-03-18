import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import { useMemo, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { Stack } from "expo-router";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { trpc } from "../lib/trpc";
import { AuthProvider, useAuth } from "../lib/auth-context";
import { getTrpcUrl } from "../lib/server";
import { colors } from "../theme";
import LoginScreen from "./login";
import ServerSetupScreen from "./server-setup";

function AuthGate() {
  const { user, serverUrl, isLoading, sessionToken } = useAuth();

  const [queryClient] = useState(() => new QueryClient());

  const trpcClient = useMemo(() => {
    const url = serverUrl ? getTrpcUrl(serverUrl) : "http://localhost:3000/api/trpc";
    return trpc.createClient({
      links: [
        httpBatchLink({
          url,
          methodOverride: "POST",
          headers: () =>
            sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {},
        }),
      ],
    });
  }, [serverUrl, sessionToken]);

  if (isLoading) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color={colors.accent} size="large" />
      </View>
    );
  }

  // Step 1: No server configured — show server setup
  if (!serverUrl) {
    return <ServerSetupScreen />;
  }

  // Step 2: No user — show login
  if (!user) {
    return <LoginScreen />;
  }

  // Step 3: Authenticated — show the app
  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <Stack>
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen
            name="food/add"
            options={{ presentation: "modal", title: "Add Food" }}
          />
          <Stack.Screen
            name="providers"
            options={{
              title: "Data Sources",
              headerStyle: { backgroundColor: colors.background },
              headerTintColor: colors.text,
            }}
          />
          <Stack.Screen
            name="settings"
            options={{
              title: "Settings",
              headerStyle: { backgroundColor: colors.background },
              headerTintColor: colors.text,
            }}
          />
          <Stack.Screen
            name="tracking"
            options={{
              title: "Tracking",
              headerStyle: { backgroundColor: colors.background },
              headerTintColor: colors.text,
            }}
          />
          <Stack.Screen
            name="training"
            options={{
              title: "Training",
              headerStyle: { backgroundColor: colors.background },
              headerTintColor: colors.text,
            }}
          />
          <Stack.Screen
            name="nutrition-analytics"
            options={{
              title: "Nutrition Analytics",
              headerStyle: { backgroundColor: colors.background },
              headerTintColor: colors.text,
            }}
          />
          <Stack.Screen
            name="insights"
            options={{
              title: "Insights",
              headerStyle: { backgroundColor: colors.background },
              headerTintColor: colors.text,
            }}
          />
          <Stack.Screen
            name="activity/[id]"
            options={{
              title: "Activity",
              headerStyle: { backgroundColor: colors.background },
              headerTintColor: colors.text,
            }}
          />
          <Stack.Screen
            name="predictions"
            options={{
              title: "Predictions",
              headerStyle: { backgroundColor: colors.background },
              headerTintColor: colors.text,
            }}
          />
          <Stack.Screen
            name="correlation"
            options={{
              title: "Correlation Explorer",
              headerStyle: { backgroundColor: colors.background },
              headerTintColor: colors.text,
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
