import { providerLabel } from "@dofek/providers/providers";
import * as AppleAuthentication from "expo-apple-authentication";
import { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { ProviderLogo } from "../components/ProviderLogo";
import {
  type ConfiguredProviders,
  fetchConfiguredProviders,
  isNativeAppleSignInAvailable,
  startNativeAppleSignIn,
  startOAuthLogin,
} from "../lib/auth";
import { useAuth } from "../lib/auth-context";
import { captureException } from "../lib/telemetry";
import { colors } from "../theme";

function hasCancelCode(
  err: unknown,
): err is { code: "ERR_REQUEST_CANCELED" | "ERR_CANCELED"; message?: string } {
  if (!err || typeof err !== "object" || !("code" in err)) {
    return false;
  }
  return err.code === "ERR_REQUEST_CANCELED" || err.code === "ERR_CANCELED";
}

export default function LoginScreen() {
  const { serverUrl, onLoginSuccess } = useAuth();
  const [providers, setProviders] = useState<ConfiguredProviders | null>(null);
  const [nativeAppleSignInAvailable, setNativeAppleSignInAvailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loggingIn, setLoggingIn] = useState(false);

  useEffect(() => {
    let mounted = true;
    void isNativeAppleSignInAvailable().then((isAvailable) => {
      if (!mounted) return;
      setNativeAppleSignInAvailable(isAvailable);
    });
    return () => {
      mounted = false;
    };
  }, []);

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
      let token: string | null;

      // Use native Apple Sign In on iOS for the apple identity provider
      if (providerId === "apple" && !isDataProvider && nativeAppleSignInAvailable) {
        token = await startNativeAppleSignIn(serverUrl);
      } else {
        token = await startOAuthLogin(serverUrl, providerId, isDataProvider);
      }

      if (token) {
        await onLoginSuccess(token);
      }
    } catch (err: unknown) {
      // User cancelled native Apple Sign In — not an error
      const isCancel =
        (err instanceof Error &&
          (err.message.includes("ERR_CANCELED") || err.message.includes("ERR_REQUEST_CANCELED"))) ||
        hasCancelCode(err);

      if (isCancel) {
        return;
      }
      captureException(err, { source: "login-screen-handle-login" });
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setLoggingIn(false);
    }
  }

  const useNativeApple =
    nativeAppleSignInAvailable && (providers?.identity.includes("apple") ?? false) && (providers?.nativeApple ?? false);
  const allProviders = providers
    ? [
        // Exclude Apple from generic list when native sign-in is available
        ...providers.identity
          .filter((id) => !(useNativeApple && id === "apple"))
          .map((id) => ({ id, isData: false })),
        ...providers.data.map((id) => ({ id, isData: true })),
      ]
    : [];

  return (
    <View style={styles.container}>
      <View style={styles.content}>
        <Text style={styles.title}>Dofek</Text>
        <Text style={styles.subtitle}>Sign in to view your health data</Text>

        {error ? (
          <View style={styles.errorContainer}>
            <Text style={styles.error}>{error}</Text>
          </View>
        ) : null}

        {loading ? (
          <ActivityIndicator color={colors.accent} style={styles.spinner} />
        ) : allProviders.length === 0 && !useNativeApple ? (
          <Text style={styles.noProviders}>No login providers configured on this server.</Text>
        ) : (
          <View style={styles.providerList}>
            {useNativeApple ? (
              <AppleAuthentication.AppleAuthenticationButton
                buttonType={AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN}
                buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.WHITE}
                cornerRadius={12}
                style={styles.appleButton}
                onPress={() => handleLogin("apple", false)}
              />
            ) : null}
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
  appleButton: {
    height: 48,
    width: "100%",
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
