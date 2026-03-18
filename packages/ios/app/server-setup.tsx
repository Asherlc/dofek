import { useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { useAuth } from "../lib/auth-context";
import { colors } from "../theme";

export default function ServerSetupScreen() {
  const { setServer } = useAuth();
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  async function handleConnect() {
    const trimmed = url.trim().replace(/\/+$/, "");
    if (!trimmed) {
      setError("Please enter a server URL");
      return;
    }

    setChecking(true);
    setError(null);

    try {
      // Verify the server is reachable by fetching providers
      const res = await fetch(`${trimmed}/api/auth/providers`);
      if (!res.ok) {
        setError(`Server returned ${res.status} — check the URL`);
        return;
      }

      await setServer(trimmed);
    } catch {
      setError("Could not connect — check the URL and try again");
    } finally {
      setChecking(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={styles.content}>
        <Text style={styles.title}>Dofek</Text>
        <Text style={styles.subtitle}>Connect to your server</Text>

        <TextInput
          style={styles.input}
          placeholder="https://dofek.example.com"
          placeholderTextColor={colors.textTertiary}
          value={url}
          onChangeText={setUrl}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          returnKeyType="go"
          onSubmitEditing={handleConnect}
        />

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <TouchableOpacity
          style={[styles.button, checking && styles.buttonDisabled]}
          onPress={handleConnect}
          disabled={checking}
        >
          {checking ? (
            <ActivityIndicator color={colors.text} />
          ) : (
            <Text style={styles.buttonText}>Connect</Text>
          )}
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
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
  input: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 16,
    color: colors.text,
    borderWidth: 1,
    borderColor: colors.surfaceSecondary,
    marginBottom: 16,
  },
  error: {
    color: colors.danger,
    fontSize: 13,
    textAlign: "center",
    marginBottom: 12,
  },
  button: {
    backgroundColor: colors.accent,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  buttonText: {
    color: colors.text,
    fontSize: 16,
    fontWeight: "600",
  },
});
