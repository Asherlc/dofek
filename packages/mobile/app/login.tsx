import { providerLabel } from "@dofek/providers/providers";
import * as AppleAuthentication from "expo-apple-authentication";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { ProviderLogo } from "../components/ProviderLogo";
import {
  type ConfiguredProviders,
  fetchConfiguredProviders,
  isNativeAppleSignInAvailable,
  loginWithPassword,
  registerWithPassword,
  requestPasswordReset,
  startNativeAppleSignIn,
  startOAuthLogin,
} from "../lib/auth";
import { useAuth } from "../lib/auth-context";
import { captureException } from "../lib/telemetry";
import { colors } from "../theme";

type AuthMode = "login" | "register" | "reset";

export default function LoginScreen() {
  const { serverUrl, onLoginSuccess } = useAuth();
  const router = useRouter();
  const [providers, setProviders] = useState<ConfiguredProviders | null>(null);
  const [nativeAppleSignInAvailable, setNativeAppleSignInAvailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loggingIn, setLoggingIn] = useState(false);
  const [authMode, setAuthMode] = useState<AuthMode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");

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
        captureException(err, { source: "login-screen-configured-providers" });
        setError(err instanceof Error ? err.message : "Failed to load providers");
      })
      .finally(() => setLoading(false));
  }, [serverUrl]);

  async function handleLogin(providerId: string, isDataProvider: boolean) {
    if (!serverUrl || loggingIn) return;

    setLoggingIn(true);
    setError(null);

    try {
      let result: { session: string; isNewUser: boolean } | null;

      if (providerId === "apple" && !isDataProvider && nativeAppleSignInAvailable) {
        result = await startNativeAppleSignIn(serverUrl);
      } else {
        result = await startOAuthLogin(serverUrl, providerId, isDataProvider);
      }

      if (result) {
        await onLoginSuccess(result.session);
        if (result.isNewUser) {
          router.replace("/onboarding");
        }
      }
    } catch (err: unknown) {
      captureException(err, { source: "login-screen-handle-login" });
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setLoggingIn(false);
    }
  }

  async function handlePasswordAuth() {
    if (!serverUrl || loggingIn) return;

    setLoggingIn(true);
    setError(null);

    try {
      const result =
        authMode === "register"
          ? await registerWithPassword(serverUrl, email.trim(), password, name.trim() || undefined)
          : await loginWithPassword(serverUrl, email.trim(), password);
      await onLoginSuccess(result.session);
      if (result.isNewUser) {
        router.replace("/onboarding");
      }
    } catch (err: unknown) {
      captureException(err, { source: "login-screen-password-auth" });
      setError(err instanceof Error ? err.message : "Authentication failed");
    } finally {
      setLoggingIn(false);
    }
  }

  async function handlePasswordReset() {
    if (!serverUrl || loggingIn) return;

    setLoggingIn(true);
    setError(null);
    try {
      const result = await requestPasswordReset(serverUrl, email.trim());
      setError(result.message);
    } catch (err: unknown) {
      captureException(err, { source: "login-screen-password-reset" });
      setError(err instanceof Error ? err.message : "Password reset failed");
    } finally {
      setLoggingIn(false);
    }
  }

  const useNativeApple =
    nativeAppleSignInAvailable &&
    (providers?.identity.includes("apple") ?? false) &&
    (providers?.nativeApple ?? false);
  const allProviders = providers
    ? [
        ...providers.identity
          .filter((id) => !(useNativeApple && id === "apple"))
          .map((id) => ({ id, isData: false })),
        ...providers.data.map((id) => ({ id, isData: true })),
      ]
    : [];
  const showPasswordAuth = providers?.password ?? false;
  const showOAuthProviders = allProviders.length > 0 || useNativeApple;

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
        ) : !showPasswordAuth && !showOAuthProviders ? (
          <Text style={styles.noProviders}>No login providers configured on this server.</Text>
        ) : (
          <View style={styles.providerList}>
            {showPasswordAuth ? (
              <View style={styles.passwordSection}>
                {authMode === "reset" ? (
                  <>
                    <TextInput
                      style={styles.input}
                      value={email}
                      onChangeText={setEmail}
                      placeholder="Email"
                      placeholderTextColor={colors.textSecondary}
                      keyboardType="email-address"
                      autoCapitalize="none"
                      autoComplete="email"
                      editable={!loggingIn}
                    />
                    <TouchableOpacity
                      style={styles.passwordButton}
                      onPress={handlePasswordReset}
                      disabled={loggingIn || !email.trim()}
                      accessibilityRole="button"
                      accessibilityLabel="Send reset link"
                      accessibilityState={{
                        busy: loggingIn,
                        disabled: loggingIn || !email.trim(),
                      }}
                    >
                      <Text style={styles.passwordButtonText}>
                        {loggingIn ? "Sending..." : "Send reset link"}
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={() => {
                        setAuthMode("login");
                        setError(null);
                      }}
                      disabled={loggingIn}
                      accessibilityRole="button"
                      accessibilityLabel="Back to sign in"
                      accessibilityState={{ disabled: loggingIn }}
                    >
                      <Text style={styles.backToSignInText}>Back to sign in</Text>
                    </TouchableOpacity>
                  </>
                ) : (
                  <>
                    <View style={styles.modeToggle}>
                      <TouchableOpacity
                        style={[styles.modeButton, authMode === "login" && styles.modeButtonActive]}
                        onPress={() => setAuthMode("login")}
                        disabled={loggingIn}
                        accessibilityRole="button"
                        accessibilityLabel="Sign in"
                        accessibilityState={{
                          disabled: loggingIn,
                          selected: authMode === "login",
                        }}
                      >
                        <Text
                          style={[
                            styles.modeButtonText,
                            authMode === "login" && styles.modeButtonTextActive,
                          ]}
                        >
                          Sign in
                        </Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={[
                          styles.modeButton,
                          authMode === "register" && styles.modeButtonActive,
                        ]}
                        onPress={() => setAuthMode("register")}
                        disabled={loggingIn}
                        accessibilityRole="button"
                        accessibilityLabel="Create account"
                        accessibilityState={{
                          disabled: loggingIn,
                          selected: authMode === "register",
                        }}
                      >
                        <Text
                          style={[
                            styles.modeButtonText,
                            authMode === "register" && styles.modeButtonTextActive,
                          ]}
                        >
                          Create account
                        </Text>
                      </TouchableOpacity>
                    </View>

                    {authMode === "register" ? (
                      <TextInput
                        style={styles.input}
                        value={name}
                        onChangeText={setName}
                        placeholder="Name"
                        placeholderTextColor={colors.textSecondary}
                        autoCapitalize="words"
                        autoComplete="name"
                        editable={!loggingIn}
                      />
                    ) : null}
                    <TextInput
                      style={styles.input}
                      value={email}
                      onChangeText={setEmail}
                      placeholder="Email"
                      placeholderTextColor={colors.textSecondary}
                      keyboardType="email-address"
                      autoCapitalize="none"
                      autoComplete="email"
                      editable={!loggingIn}
                    />
                    <TextInput
                      style={styles.input}
                      value={password}
                      onChangeText={setPassword}
                      placeholder="Password"
                      placeholderTextColor={colors.textSecondary}
                      secureTextEntry
                      autoComplete={authMode === "register" ? "new-password" : "password"}
                      editable={!loggingIn}
                    />
                    {authMode === "login" ? (
                      <TouchableOpacity
                        onPress={() => {
                          setAuthMode("reset");
                          setError(null);
                        }}
                        disabled={loggingIn}
                        accessibilityRole="button"
                        accessibilityLabel="Forgot password?"
                        accessibilityState={{ disabled: loggingIn }}
                      >
                        <Text style={styles.forgotPasswordText}>Forgot password?</Text>
                      </TouchableOpacity>
                    ) : null}
                    <TouchableOpacity
                      style={styles.passwordButton}
                      onPress={handlePasswordAuth}
                      disabled={loggingIn || !email.trim() || !password}
                      accessibilityRole="button"
                      accessibilityLabel={
                        authMode === "register" ? "Create account" : "Sign in with email"
                      }
                      accessibilityState={{
                        busy: loggingIn,
                        disabled: loggingIn || !email.trim() || !password,
                      }}
                    >
                      <Text style={styles.passwordButtonText}>
                        {loggingIn
                          ? authMode === "register"
                            ? "Creating account..."
                            : "Signing in..."
                          : authMode === "register"
                            ? "Create account"
                            : "Sign in with email"}
                      </Text>
                    </TouchableOpacity>
                  </>
                )}
              </View>
            ) : null}

            {showPasswordAuth && showOAuthProviders ? (
              <Text style={styles.dividerText}>or continue with</Text>
            ) : null}

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
                accessibilityRole="button"
                accessibilityLabel={`Sign in with ${providerLabel(id)}`}
                accessibilityState={{ busy: loggingIn, disabled: loggingIn }}
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
  passwordSection: {
    gap: 12,
    marginBottom: 4,
  },
  modeToggle: {
    flexDirection: "row",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.surfaceSecondary,
    overflow: "hidden",
  },
  modeButton: {
    flex: 1,
    paddingVertical: 10,
    alignItems: "center",
    backgroundColor: colors.surface,
  },
  modeButtonActive: {
    backgroundColor: colors.surfaceSecondary,
  },
  modeButtonText: {
    color: colors.textSecondary,
    fontSize: 14,
    fontWeight: "500",
  },
  modeButtonTextActive: {
    color: colors.text,
  },
  input: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: colors.surfaceSecondary,
    color: colors.text,
    fontSize: 15,
  },
  passwordButton: {
    backgroundColor: colors.accent,
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 16,
  },
  passwordButtonText: {
    color: colors.background,
    fontSize: 15,
    fontWeight: "600",
    textAlign: "center",
  },
  forgotPasswordText: {
    color: colors.textSecondary,
    fontSize: 13,
    textAlign: "center",
  },
  backToSignInText: {
    color: colors.textSecondary,
    fontSize: 13,
    textAlign: "center",
  },
  dividerText: {
    color: colors.textSecondary,
    fontSize: 12,
    textAlign: "center",
    textTransform: "uppercase",
    letterSpacing: 1,
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
