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
          <TouchableOpacity
            style={[styles.signInButton, loading && styles.signInButtonDisabled]}
            onPress={handleSignIn}
            activeOpacity={0.7}
            disabled={loading || !username || !password}
            accessibilityRole="button"
            accessibilityLabel={`Sign in to ${providerName}`}
            accessibilityState={{
              busy: loading,
              disabled: loading || !username || !password,
            }}
          >
            <Text style={styles.signInButtonText}>{loading ? "Signing in..." : "Sign In"}</Text>
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
          <TouchableOpacity
            style={[styles.signInButton, loading && styles.signInButtonDisabled]}
            onPress={handleConnect}
            activeOpacity={0.7}
            disabled={loading || !token}
            accessibilityRole="button"
            accessibilityLabel={`Connect ${providerName}`}
            accessibilityState={{
              busy: loading,
              disabled: loading || !token,
            }}
          >
            <Text style={styles.signInButtonText}>{loading ? "Connecting..." : "Connect"}</Text>
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
          <TouchableOpacity
            style={[styles.signInButton, loading && styles.signInButtonDisabled]}
            onPress={handleSignIn}
            activeOpacity={0.7}
            disabled={loading || !username || !password}
            accessibilityRole="button"
            accessibilityLabel="Sign in to Garmin"
            accessibilityState={{
              busy: loading,
              disabled: loading || !username || !password,
            }}
          >
            <Text style={styles.signInButtonText}>{loading ? "Signing in..." : "Sign In"}</Text>
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
              <TouchableOpacity
                style={[styles.signInButton, loading && styles.signInButtonDisabled]}
                onPress={handleSignIn}
                activeOpacity={0.7}
                disabled={loading || !username || !password}
                accessibilityRole="button"
                accessibilityLabel="Sign in to WHOOP"
                accessibilityState={{
                  busy: loading,
                  disabled: loading || !username || !password,
                }}
              >
                <Text style={styles.signInButtonText}>{loading ? "Signing in..." : "Sign In"}</Text>
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
              <TouchableOpacity
                style={[styles.signInButton, loading && styles.signInButtonDisabled]}
                onPress={handleVerify}
                activeOpacity={0.7}
                disabled={loading || !code}
                accessibilityRole="button"
                accessibilityLabel="Verify WHOOP code"
                accessibilityState={{
                  busy: loading,
                  disabled: loading || !code,
                }}
              >
                <Text style={styles.signInButtonText}>{loading ? "Verifying..." : "Verify"}</Text>
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
