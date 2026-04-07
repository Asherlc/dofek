import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Modal, Text, TextInput, TouchableOpacity, View } from "react-native";
import { trpc } from "../../lib/trpc";
import { colors } from "../../theme";
import { styles } from "./styles.ts";

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
            <TouchableOpacity onPress={onClose} activeOpacity={0.7}>
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
          >
            <Text style={styles.signInButtonText}>{loading ? "Signing in..." : "Sign In"}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
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
            <TouchableOpacity onPress={handleClose} activeOpacity={0.7} disabled={loading}>
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
            <TouchableOpacity onPress={handleClose} activeOpacity={0.7} disabled={!canClose}>
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
