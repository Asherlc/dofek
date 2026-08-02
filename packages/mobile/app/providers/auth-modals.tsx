import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Modal,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { captureException } from "../../lib/telemetry";
import { trpc } from "../../lib/trpc";
import { colors } from "../../theme";
import { styles } from "./styles.ts";
import type { ProviderDetailModals } from "./use-provider-detail-actions.ts";

function credentialSubmitHint(username: string, password: string, loading: boolean) {
  if (loading) return null;
  if (!username.trim() && !password) return "Enter your email and password to continue.";
  if (!username.trim()) return "Enter your email to continue.";
  if (!password) return "Enter your password to continue.";
  return null;
}

// ── Generic Credential Auth Modal ──

export function CredentialAuthModal({
  providerId,
  providerName,
  onClose,
  onSuccess,
}: {
  providerId: string;
  providerName: string;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const emailRef = useRef<TextInput>(null);
  const signInDisabled = loading || !username.trim() || !password;
  const signInHint = credentialSubmitHint(username, password, loading);

  useEffect(() => {
    emailRef.current?.focus();
  }, []);

  const signInMutation = trpc.credentialAuth.signIn.useMutation();

  const handleSignIn = useCallback(async () => {
    setError("");
    setLoading(true);
    try {
      await signInMutation.mutateAsync({ providerId, username, password });
      onSuccess();
    } catch (err: unknown) {
      captureException(err, {
        source: "provider-credential-auth-sign-in",
        providerId,
      });
      setError(err instanceof Error ? err.message : "Sign in failed");
    } finally {
      setLoading(false);
    }
  }, [providerId, username, password, signInMutation, onSuccess]);

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.modalOverlay}>
        <View style={styles.modalContent}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Connect {providerName}</Text>
            <TouchableOpacity
              onPress={onClose}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel={`Close ${providerName} connection`}
            >
              <Text style={styles.modalClose}>{"\u00D7"}</Text>
            </TouchableOpacity>
          </View>

          {error ? (
            <View style={styles.errorBanner}>
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}

          <TextInput
            ref={emailRef}
            style={styles.input}
            placeholder="Email"
            placeholderTextColor={colors.textTertiary}
            value={username}
            onChangeText={setUsername}
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
          />
          <TextInput
            style={styles.input}
            placeholder="Password"
            placeholderTextColor={colors.textTertiary}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
          />
          {signInHint ? <Text style={styles.disabledHint}>{signInHint}</Text> : null}
          <TouchableOpacity
            style={[styles.signInButton, signInDisabled && styles.signInButtonDisabled]}
            onPress={handleSignIn}
            activeOpacity={0.7}
            disabled={signInDisabled}
            accessibilityRole="button"
            accessibilityLabel={`Sign in to ${providerName}`}
            accessibilityHint={signInHint ?? undefined}
            accessibilityState={{
              busy: loading,
              disabled: signInDisabled,
            }}
          >
            <Text
              style={[styles.signInButtonText, signInDisabled && styles.signInButtonTextDisabled]}
            >
              {loading ? "Signing in..." : "Sign In"}
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

// ── Personal Token Auth Modal ──

export function TokenAuthModal({
  providerId,
  providerName,
  tokenLabel,
  instructionsUrl,
  onClose,
  onSuccess,
}: {
  providerId: string;
  providerName: string;
  tokenLabel: string;
  instructionsUrl: string;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const tokenRef = useRef<TextInput>(null);
  const connectDisabled = loading || !token;
  const connectHint = !loading && !token ? "Enter your token to continue." : null;
  const connectMutation = trpc.tokenAuth.connect.useMutation();

  useEffect(() => {
    tokenRef.current?.focus();
  }, []);

  const handleClose = useCallback(() => {
    if (!loading) onClose();
  }, [loading, onClose]);

  const handleConnect = useCallback(async () => {
    setError("");
    setLoading(true);
    try {
      await connectMutation.mutateAsync({ providerId, token });
    } catch (caught: unknown) {
      captureException(caught, {
        source: "provider-token-auth-connect",
        providerId,
      });
      setError(caught instanceof Error ? caught.message : "Token connection failed");
      setLoading(false);
      return;
    }
    setLoading(false);
    onSuccess();
  }, [connectMutation, onSuccess, providerId, token]);

  const openInstructions = useCallback(() => {
    void Linking.openURL(instructionsUrl).catch((caught: unknown) => {
      captureException(caught, {
        source: "provider-token-auth-instructions",
        providerId,
      });
      setError(caught instanceof Error ? caught.message : "Could not open token instructions");
    });
  }, [instructionsUrl, providerId]);

  return (
    <Modal visible transparent animationType="fade" onRequestClose={handleClose}>
      <View style={styles.modalOverlay}>
        <View style={styles.modalContent}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Connect {providerName}</Text>
            <TouchableOpacity
              onPress={handleClose}
              activeOpacity={0.7}
              disabled={loading}
              accessibilityRole="button"
              accessibilityLabel={`Close ${providerName} connection`}
              accessibilityState={{ disabled: loading }}
            >
              <Text style={styles.modalClose}>{"\u00D7"}</Text>
            </TouchableOpacity>
          </View>

          <TouchableOpacity
            onPress={openInstructions}
            activeOpacity={0.7}
            accessibilityRole="link"
            accessibilityLabel={`Create a ${tokenLabel}`}
          >
            <Text style={styles.modalDescription}>
              Create a {tokenLabel} in {providerName}, then paste it below.
            </Text>
          </TouchableOpacity>

          {error ? (
            <View style={styles.errorBanner}>
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}

          <TextInput
            ref={tokenRef}
            style={styles.input}
            placeholder={tokenLabel}
            placeholderTextColor={colors.textTertiary}
            value={token}
            onChangeText={setToken}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
          />
          {connectHint ? <Text style={styles.disabledHint}>{connectHint}</Text> : null}
          <TouchableOpacity
            style={[styles.signInButton, connectDisabled && styles.signInButtonDisabled]}
            onPress={handleConnect}
            activeOpacity={0.7}
            disabled={connectDisabled}
            accessibilityRole="button"
            accessibilityLabel={`Connect ${providerName}`}
            accessibilityHint={connectHint ?? undefined}
            accessibilityState={{
              busy: loading,
              disabled: connectDisabled,
            }}
          >
            <Text
              style={[styles.signInButtonText, connectDisabled && styles.signInButtonTextDisabled]}
            >
              {loading ? "Connecting..." : "Connect"}
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

export function ProviderDetailAuthModals({ modals }: { modals: ProviderDetailModals }) {
  return (
    <>
      {modals.credentialAuthProvider && (
        <CredentialAuthModal
          providerId={modals.credentialAuthProvider.id}
          providerName={modals.credentialAuthProvider.name}
          onClose={modals.closeCredentialAuth}
          onSuccess={modals.handleCredentialSuccess}
        />
      )}
      {modals.tokenAuthProvider && (
        <TokenAuthModal
          providerId={modals.tokenAuthProvider.id}
          providerName={modals.tokenAuthProvider.name}
          tokenLabel={modals.tokenAuthProvider.label}
          instructionsUrl={modals.tokenAuthProvider.instructionsUrl}
          onClose={modals.closeTokenAuth}
          onSuccess={modals.handleTokenSuccess}
        />
      )}
      {modals.whoopAuthOpen && (
        <WhoopAuthModal onClose={modals.closeWhoopAuth} onSuccess={modals.handleWhoopSuccess} />
      )}
      {modals.garminAuthOpen && (
        <GarminAuthModal onClose={modals.closeGarminAuth} onSuccess={modals.handleGarminSuccess} />
      )}
    </>
  );
}

// ── Garmin Auth Modal ──

export function GarminAuthModal({
  onClose,
  onSuccess,
}: {
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const emailRef = useRef<TextInput>(null);
  const signInDisabled = loading || !username.trim() || !password;
  const signInHint = credentialSubmitHint(username, password, loading);

  useEffect(() => {
    emailRef.current?.focus();
  }, []);

  const signInMutation = trpc.garminAuth.signIn.useMutation();

  const handleSignIn = useCallback(async () => {
    setError("");
    setLoading(true);
    try {
      await signInMutation.mutateAsync({ username, password });
      onSuccess();
    } catch (error_: unknown) {
      captureException(error_, {
        source: "provider-garmin-auth-sign-in",
        providerId: "garmin",
      });
      setError(error_ instanceof Error ? error_.message : "Sign in failed");
    } finally {
      setLoading(false);
    }
  }, [username, password, signInMutation, onSuccess]);

  const handleClose = useCallback(() => {
    if (!loading) onClose();
  }, [loading, onClose]);

  return (
    <Modal visible transparent animationType="fade" onRequestClose={handleClose}>
      <View style={styles.modalOverlay}>
        <View style={styles.modalContent}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Connect Garmin</Text>
            <TouchableOpacity
              onPress={handleClose}
              activeOpacity={0.7}
              disabled={loading}
              accessibilityRole="button"
              accessibilityLabel="Close Garmin connection"
              accessibilityState={{ disabled: loading }}
            >
              <Text style={styles.modalClose}>{"\u00D7"}</Text>
            </TouchableOpacity>
          </View>

          {error ? (
            <View style={styles.errorBanner}>
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}

          <TextInput
            ref={emailRef}
            style={styles.input}
            placeholder="Email"
            placeholderTextColor={colors.textTertiary}
            value={username}
            onChangeText={setUsername}
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
          />
          <TextInput
            style={styles.input}
            placeholder="Password"
            placeholderTextColor={colors.textTertiary}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
          />
          {signInHint ? <Text style={styles.disabledHint}>{signInHint}</Text> : null}
          <TouchableOpacity
            style={[styles.signInButton, signInDisabled && styles.signInButtonDisabled]}
            onPress={handleSignIn}
            activeOpacity={0.7}
            disabled={signInDisabled}
            accessibilityRole="button"
            accessibilityLabel="Sign in to Garmin"
            accessibilityHint={signInHint ?? undefined}
            accessibilityState={{
              busy: loading,
              disabled: signInDisabled,
            }}
          >
            <Text
              style={[styles.signInButtonText, signInDisabled && styles.signInButtonTextDisabled]}
            >
              {loading ? "Signing in..." : "Sign In"}
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

// ── WHOOP Auth Modal ──

type WhoopStep = "credentials" | "verify" | "saving";

export function WhoopAuthModal({
  onClose,
  onSuccess,
}: {
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [step, setStep] = useState<WhoopStep>("credentials");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [challengeId, setChallengeId] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const emailRef = useRef<TextInput>(null);
  const codeRef = useRef<TextInput>(null);
  const credentialSignInDisabled = loading || !username.trim() || !password;
  const credentialSignInHint = credentialSubmitHint(username, password, loading);
  const verificationDisabled = loading || !code;
  const verificationHint = !loading && !code ? "Enter the verification code to continue." : null;

  useEffect(() => {
    if (step === "credentials") emailRef.current?.focus();
    if (step === "verify") codeRef.current?.focus();
  }, [step]);

  const signInMutation = trpc.whoopAuth.signIn.useMutation();
  const verifyMutation = trpc.whoopAuth.verifyCode.useMutation();
  const saveTokensMutation = trpc.whoopAuth.saveTokens.useMutation();

  const handleSignIn = useCallback(async () => {
    setError("");
    setLoading(true);
    try {
      const result = await signInMutation.mutateAsync({ username, password });
      if (result.status === "verification_required") {
        setChallengeId(result.challengeId);
        setStep("verify");
      } else if (result.status === "success" && result.token) {
        setStep("saving");
        await saveTokensMutation.mutateAsync(result.token);
        onSuccess();
      }
    } catch (error_: unknown) {
      captureException(error_, {
        source: "provider-whoop-auth-sign-in",
        providerId: "whoop",
      });
      setError(error_ instanceof Error ? error_.message : "Sign in failed");
    } finally {
      setLoading(false);
    }
  }, [username, password, signInMutation, saveTokensMutation, onSuccess]);

  const handleVerify = useCallback(async () => {
    setError("");
    setLoading(true);
    try {
      const result = await verifyMutation.mutateAsync({ challengeId, code });
      if (result.status === "success") {
        setStep("saving");
        await saveTokensMutation.mutateAsync(result.token);
        onSuccess();
      }
    } catch (error_: unknown) {
      captureException(error_, {
        source: "provider-whoop-auth-verify",
        providerId: "whoop",
      });
      setError(error_ instanceof Error ? error_.message : "Verification failed");
    } finally {
      setLoading(false);
    }
  }, [challengeId, code, verifyMutation, saveTokensMutation, onSuccess]);

  const canClose = !loading && step !== "saving";
  const handleClose = useCallback(() => {
    if (canClose) onClose();
  }, [canClose, onClose]);

  return (
    <Modal visible transparent animationType="fade" onRequestClose={handleClose}>
      <View style={styles.modalOverlay}>
        <View style={styles.modalContent}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>
              {step === "verify" ? "Verify Code" : "Connect WHOOP"}
            </Text>
            <TouchableOpacity
              onPress={handleClose}
              activeOpacity={0.7}
              disabled={!canClose}
              accessibilityRole="button"
              accessibilityLabel="Close WHOOP connection"
              accessibilityState={{ disabled: !canClose }}
            >
              <Text style={styles.modalClose}>{"\u00D7"}</Text>
            </TouchableOpacity>
          </View>

          {error ? (
            <View style={styles.errorBanner}>
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}

          {step === "credentials" && (
            <>
              <TextInput
                ref={emailRef}
                style={styles.input}
                placeholder="Email"
                placeholderTextColor={colors.textTertiary}
                value={username}
                onChangeText={setUsername}
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
              />
              <TextInput
                style={styles.input}
                placeholder="Password"
                placeholderTextColor={colors.textTertiary}
                value={password}
                onChangeText={setPassword}
                secureTextEntry
              />
              {credentialSignInHint ? (
                <Text style={styles.disabledHint}>{credentialSignInHint}</Text>
              ) : null}
              <TouchableOpacity
                style={[
                  styles.signInButton,
                  credentialSignInDisabled && styles.signInButtonDisabled,
                ]}
                onPress={handleSignIn}
                activeOpacity={0.7}
                disabled={credentialSignInDisabled}
                accessibilityRole="button"
                accessibilityLabel="Sign in to WHOOP"
                accessibilityHint={credentialSignInHint ?? undefined}
                accessibilityState={{
                  busy: loading,
                  disabled: credentialSignInDisabled,
                }}
              >
                <Text
                  style={[
                    styles.signInButtonText,
                    credentialSignInDisabled && styles.signInButtonTextDisabled,
                  ]}
                >
                  {loading ? "Signing in..." : "Sign In"}
                </Text>
              </TouchableOpacity>
            </>
          )}

          {step === "verify" && (
            <>
              <Text style={styles.verifyDescription}>
                Enter the verification code sent to your device.
              </Text>
              <TextInput
                ref={codeRef}
                style={styles.input}
                placeholder="Verification code"
                placeholderTextColor={colors.textTertiary}
                value={code}
                onChangeText={setCode}
                keyboardType="number-pad"
                autoCapitalize="none"
              />
              {verificationHint ? (
                <Text style={styles.disabledHint}>{verificationHint}</Text>
              ) : null}
              <TouchableOpacity
                style={[styles.signInButton, verificationDisabled && styles.signInButtonDisabled]}
                onPress={handleVerify}
                activeOpacity={0.7}
                disabled={verificationDisabled}
                accessibilityRole="button"
                accessibilityLabel="Verify WHOOP code"
                accessibilityHint={verificationHint ?? undefined}
                accessibilityState={{
                  busy: loading,
                  disabled: verificationDisabled,
                }}
              >
                <Text
                  style={[
                    styles.signInButtonText,
                    verificationDisabled && styles.signInButtonTextDisabled,
                  ]}
                >
                  {loading ? "Verifying..." : "Verify"}
                </Text>
              </TouchableOpacity>
            </>
          )}

          {step === "saving" && (
            <View style={styles.savingContainer}>
              <ActivityIndicator color={colors.accent} size="small" />
              <Text style={styles.savingText}>Saving credentials...</Text>
            </View>
          )}
        </View>
      </View>
    </Modal>
  );
}
