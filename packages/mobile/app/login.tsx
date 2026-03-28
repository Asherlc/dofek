import { providerLabel } from "@dofek/providers/providers";
import { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { ProviderLogo } from "../components/ProviderLogo";
import { type ConfiguredProviders, fetchConfiguredProviders, startOAuthLogin } from "../lib/auth";
import { useAuth } from "../lib/auth-context";
import { colors } from "../theme";

export default function LoginScreen() {
  const { serverUrl, onLoginSuccess } = useAuth();
  const [providers, setProviders] = useState<ConfiguredProviders | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loggingIn, setLoggingIn] = useState(false);

  useEffect(() => {
    if (!serverUrl) return;

    fetchConfiguredProviders(serverUrl)
      .then(setProviders)
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Failed to load providers");
      })
      .finally(() => setLoading(false));
  }, [serverUrl]);

  async function handleLogin(providerId: string, isDataProvider: boolean) {
    if (!serverUrl || loggingIn) return;

    setLoggingIn(true);
    setError(null);

    try {
      const token = await startOAuthLogin(serverUrl, providerId, isDataProvider);
      if (token) {
        await onLoginSuccess(token);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setLoggingIn(false);
    }
  }

  const allProviders = providers
    ? [
        ...providers.identity.map((id) => ({ id, isData: false })),
        ...providers.data.map((id) => ({ id, isData: true })),
      ]
    : [];

  return (
    <View style={styles.container}>
      <View style={styles.content}>
        <Text style={styles.title}>Dofek</Text>
        <Text style={styles.subtitle}>Sign in to view your health data</Text>

        {loading ? (
          <ActivityIndicator color={colors.accent} style={styles.spinner} />
        ) : error ? (
          <View style={styles.errorContainer}>
            <Text style={styles.error}>{error}</Text>
          </View>
        ) : allProviders.length === 0 ? (
          <Text style={styles.noProviders}>No login providers configured on this server.</Text>
        ) : (
          <View style={styles.providerList}>
            {allProviders.map(({ id, isData }) => (
              <TouchableOpacity
                key={id}
                style={styles.providerButton}
                onPress={() => handleLogin(id, isData)}
                disabled={loggingIn}
              >
                <View style={styles.providerButtonContent}>
                  <ProviderLogo provider={id} serverUrl={serverUrl} size={20} />
                  <Text style={styles.providerText}>Sign in with {providerLabel(id)}</Text>
                </View>
              </TouchableOpacity>
            ))}
          </View>
        )}

        {loggingIn ? <ActivityIndicator color={colors.accent} style={styles.spinner} /> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  content: {
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: 32,
  },
  title: {
    fontSize: 32,
    fontWeight: "700",
    color: colors.text,
    textAlign: "center",
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 15,
    color: colors.textSecondary,
    textAlign: "center",
    marginBottom: 32,
  },
  spinner: {
    marginVertical: 24,
  },
  errorContainer: {
    marginBottom: 16,
  },
  error: {
    color: colors.danger,
    fontSize: 13,
    textAlign: "center",
  },
  noProviders: {
    color: colors.textSecondary,
    fontSize: 14,
    textAlign: "center",
  },
  providerList: {
    gap: 12,
  },
  providerButton: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: colors.surfaceSecondary,
  },
  providerButtonContent: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  providerText: {
    color: colors.text,
    fontSize: 15,
    fontWeight: "500",
  },
});
