import {
  getEmailValidationError,
  getNewPasswordValidationError,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PASSWORD_REQUIREMENT_TEXT,
} from "@dofek/auth/auth";
import { providerLabel } from "@dofek/providers/providers";
import * as AppleAuthentication from "expo-apple-authentication";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  useWindowDimensions,
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

const IOS_PASSWORD_RULES = `minlength: ${PASSWORD_MIN_LENGTH}; maxlength: ${PASSWORD_MAX_LENGTH};`;

export default function LoginScreen() {
  const { serverUrl, onLoginSuccess } = useAuth();
  const router = useRouter();
  const [providers, setProviders] = useState<ConfiguredProviders | null>(null);
  const [nativeAppleSignInAvailable, setNativeAppleSignInAvailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loggingIn, setLoggingIn] = useState(false);
  const [authMode, setAuthMode] = useState<AuthMode>("login");
  const [formError, setFormError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [emailTouched, setEmailTouched] = useState(false);
  const [password, setPassword] = useState("");
  const [passwordTouched, setPasswordTouched] = useState(false);
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [name, setName] = useState("");
  const { fontScale } = useWindowDimensions();
  const stackModeButtons = fontScale > 1;

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

    const emailError = getEmailValidationError(email);
    const passwordError =
      password.length === 0
        ? "Enter your password."
        : authMode === "register"
          ? getNewPasswordValidationError(password)
          : null;
    setEmailTouched(true);
    setPasswordTouched(true);
    if (emailError || passwordError) return;

    setLoggingIn(true);
    setError(null);
    setFormError(null);

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
      setFormError(err instanceof Error ? err.message : "Authentication failed");
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

  function changeAuthMode(nextAuthMode: AuthMode) {
    setAuthMode(nextAuthMode);
    setError(null);
    setFormError(null);
    setEmailTouched(false);
    setPasswordTouched(false);
    setPasswordVisible(false);
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
  const passwordResetDisabled = loggingIn || !email.trim();
  const passwordAuthDisabled = loggingIn || !email.trim() || !password;
  const emailValidationError =
    authMode === "reset" || !emailTouched ? null : getEmailValidationError(email);
  const passwordValidationError = passwordTouched
    ? password.length === 0
      ? "Enter your password."
      : authMode === "register"
        ? getNewPasswordValidationError(password)
        : null
    : null;

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.scrollContent}
      automaticallyAdjustKeyboardInsets
      contentInsetAdjustmentBehavior="automatic"
      keyboardDismissMode="interactive"
      keyboardShouldPersistTaps="handled"
    >
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
                    <View style={styles.fieldGroup}>
                      <Text style={styles.fieldLabel}>Email</Text>
                      <TextInput
                        accessibilityLabel="Email"
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
                    </View>
                    <TouchableOpacity
                      style={[
                        styles.passwordButton,
                        passwordResetDisabled && styles.passwordButtonDisabled,
                      ]}
                      onPress={handlePasswordReset}
                      disabled={passwordResetDisabled}
                      accessibilityRole="button"
                      accessibilityLabel="Send reset link"
                      accessibilityState={{
                        busy: loggingIn,
                        disabled: passwordResetDisabled,
                      }}
                    >
                      <Text style={styles.passwordButtonText}>
                        {loggingIn ? "Sending..." : "Send reset link"}
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={() => changeAuthMode("login")}
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
                    <View style={[styles.modeToggle, stackModeButtons && styles.modeToggleStacked]}>
                      <TouchableOpacity
                        style={[
                          styles.modeButton,
                          stackModeButtons && styles.modeButtonStacked,
                          authMode === "login" && styles.modeButtonActive,
                        ]}
                        onPress={() => changeAuthMode("login")}
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
                          stackModeButtons && styles.modeButtonStacked,
                          authMode === "register" && styles.modeButtonActive,
                        ]}
                        onPress={() => changeAuthMode("register")}
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
                      <View style={styles.fieldGroup}>
                        <Text style={styles.fieldLabel}>Name</Text>
                        <TextInput
                          accessibilityLabel="Name"
                          style={styles.input}
                          value={name}
                          onChangeText={setName}
                          placeholder="Name"
                          placeholderTextColor={colors.textSecondary}
                          autoCapitalize="words"
                          autoComplete="name"
                          editable={!loggingIn}
                        />
                      </View>
                    ) : null}
                    <View style={styles.fieldGroup}>
                      <Text style={styles.fieldLabel}>Email</Text>
                      <TextInput
                        accessibilityLabel="Email"
                        style={[styles.input, emailValidationError && styles.inputError]}
                        value={email}
                        onChangeText={(nextEmail) => {
                          setEmail(nextEmail);
                          setFormError(null);
                        }}
                        onBlur={() => setEmailTouched(true)}
                        placeholder="Email"
                        placeholderTextColor={colors.textSecondary}
                        keyboardType="email-address"
                        autoCapitalize="none"
                        autoComplete="email"
                        editable={!loggingIn}
                      />
                      {emailValidationError ? (
                        <Text
                          style={styles.fieldError}
                          accessibilityLiveRegion="polite"
                          accessibilityRole="alert"
                        >
                          {emailValidationError}
                        </Text>
                      ) : null}
                    </View>
                    <View style={styles.fieldGroup}>
                      <Text style={styles.fieldLabel}>Password</Text>
                      <View
                        style={[
                          styles.passwordInputContainer,
                          (passwordValidationError || formError) && styles.inputError,
                        ]}
                      >
                        <TextInput
                          accessibilityLabel="Password"
                          style={styles.passwordInput}
                          value={password}
                          onChangeText={(nextPassword) => {
                            setPassword(nextPassword);
                            setFormError(null);
                          }}
                          onBlur={() => setPasswordTouched(true)}
                          placeholder="Password"
                          placeholderTextColor={colors.textSecondary}
                          secureTextEntry={!passwordVisible}
                          autoComplete={
                            authMode === "register" ? "new-password" : "current-password"
                          }
                          passwordRules={authMode === "register" ? IOS_PASSWORD_RULES : undefined}
                          editable={!loggingIn}
                        />
                        <TouchableOpacity
                          onPress={() => setPasswordVisible((isVisible) => !isVisible)}
                          disabled={loggingIn}
                          accessibilityRole="button"
                          accessibilityLabel={passwordVisible ? "Hide password" : "Show password"}
                          accessibilityState={{ disabled: loggingIn }}
                          style={styles.passwordVisibilityButton}
                        >
                          <Text style={styles.passwordVisibilityText}>
                            {passwordVisible ? "Hide" : "Show"}
                          </Text>
                        </TouchableOpacity>
                      </View>
                      {passwordValidationError || formError ? (
                        <Text
                          style={styles.fieldError}
                          accessibilityLiveRegion="polite"
                          accessibilityRole="alert"
                        >
                          {passwordValidationError ?? formError}
                        </Text>
                      ) : authMode === "register" ? (
                        <Text style={styles.fieldHint}>{PASSWORD_REQUIREMENT_TEXT}</Text>
                      ) : null}
                    </View>
                    {authMode === "login" ? (
                      <TouchableOpacity
                        onPress={() => changeAuthMode("reset")}
                        disabled={loggingIn}
                        accessibilityRole="button"
                        accessibilityLabel="Forgot password?"
                        accessibilityState={{ disabled: loggingIn }}
                      >
                        <Text style={styles.forgotPasswordText}>Forgot password?</Text>
                      </TouchableOpacity>
                    ) : null}
                    <TouchableOpacity
                      style={[
                        styles.passwordButton,
                        passwordAuthDisabled && styles.passwordButtonDisabled,
                      ]}
                      onPress={handlePasswordAuth}
                      disabled={passwordAuthDisabled}
                      accessibilityRole="button"
                      accessibilityLabel={
                        authMode === "register" ? "Create account" : "Sign in with email"
                      }
                      accessibilityState={{
                        busy: loggingIn,
                        disabled: passwordAuthDisabled,
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
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  scrollContent: {
    flexGrow: 1,
  },
  content: {
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: 32,
    paddingVertical: 32,
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
  modeToggleStacked: {
    flexDirection: "column",
  },
  modeButton: {
    flex: 1,
    paddingVertical: 10,
    alignItems: "center",
    backgroundColor: colors.surface,
  },
  modeButtonStacked: {
    flex: 0,
    width: "100%",
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
  fieldGroup: {
    gap: 6,
  },
  fieldLabel: {
    color: colors.textSecondary,
    fontSize: 13,
    fontWeight: "500",
  },
  fieldHint: {
    color: colors.textSecondary,
    fontSize: 12,
  },
  fieldError: {
    color: colors.danger,
    fontSize: 12,
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
  inputError: {
    borderColor: colors.danger,
  },
  passwordInputContainer: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.surfaceSecondary,
  },
  passwordInput: {
    flex: 1,
    paddingVertical: 14,
    paddingLeft: 16,
    paddingRight: 8,
    color: colors.text,
    fontSize: 15,
  },
  passwordVisibilityButton: {
    alignSelf: "stretch",
    justifyContent: "center",
    paddingHorizontal: 16,
  },
  passwordVisibilityText: {
    color: colors.accent,
    fontSize: 13,
    fontWeight: "600",
  },
  passwordButton: {
    backgroundColor: colors.accent,
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 16,
  },
  passwordButtonDisabled: {
    opacity: 0.5,
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
