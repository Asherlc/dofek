import type { DeveloperClientSecret } from "@dofek/auth/developer-clients";
import * as Clipboard from "expo-clipboard";
import { useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { captureException } from "../lib/telemetry";
import { colors, fontSize, fontWeight, radius, spacing } from "../theme";

export interface DeveloperClientSecretPanelContentProps {
  copyError: string | null;
  onCopyClientId: () => void;
  onCopyClientSecret: () => void;
  onDismiss: () => void;
  secret: DeveloperClientSecret;
}

export function DeveloperClientSecretPanelContent({
  copyError,
  onCopyClientId,
  onCopyClientSecret,
  onDismiss,
  secret,
}: DeveloperClientSecretPanelContentProps) {
  return (
    <View accessibilityLabel="One-time developer credential" style={styles.panel}>
      <Text style={styles.title}>Save your developer credential</Text>
      <Text style={styles.description}>
        This secret is shown only once and cannot be recovered. Store it securely before closing.
      </Text>

      <Text style={styles.label}>Client ID</Text>
      <View style={styles.valueRow}>
        <Text selectable style={styles.value}>
          {secret.client.clientId}
        </Text>
        <TouchableOpacity
          accessibilityLabel="Copy client ID"
          accessibilityRole="button"
          onPress={onCopyClientId}
          style={styles.copyButton}
        >
          <Text style={styles.copyButtonText}>Copy</Text>
        </TouchableOpacity>
      </View>

      <Text style={styles.label}>Client secret</Text>
      <View style={styles.valueRow}>
        <Text selectable style={styles.value}>
          {secret.clientSecret}
        </Text>
        <TouchableOpacity
          accessibilityLabel="Copy client secret"
          accessibilityRole="button"
          onPress={onCopyClientSecret}
          style={styles.copyButton}
        >
          <Text style={styles.copyButtonText}>Copy</Text>
        </TouchableOpacity>
      </View>

      {copyError ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {copyError}
        </Text>
      ) : null}
      <TouchableOpacity
        accessibilityLabel="I saved the secret"
        accessibilityRole="button"
        onPress={onDismiss}
        style={styles.primaryButton}
      >
        <Text style={styles.primaryButtonText}>I saved the secret</Text>
      </TouchableOpacity>
    </View>
  );
}

export function DeveloperClientSecretPanel({
  onDismiss,
  secret,
}: {
  onDismiss: () => void;
  secret: DeveloperClientSecret;
}) {
  const [copyError, setCopyError] = useState<string | null>(null);

  async function copy(value: string): Promise<void> {
    setCopyError(null);
    try {
      await Clipboard.setStringAsync(value);
    } catch (error: unknown) {
      captureException(error, { source: "developer-client-copy" });
      setCopyError("Copy failed. Select and copy the value manually.");
    }
  }

  return (
    <DeveloperClientSecretPanelContent
      copyError={copyError}
      onCopyClientId={() => void copy(secret.client.clientId)}
      onCopyClientSecret={() => void copy(secret.clientSecret)}
      onDismiss={onDismiss}
      secret={secret}
    />
  );
}

const styles = StyleSheet.create({
  panel: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.sm,
    padding: spacing.md,
  },
  title: { color: colors.text, fontSize: fontSize.lg, fontWeight: fontWeight.bold },
  description: { color: colors.textSecondary, fontSize: fontSize.sm },
  label: { color: colors.textSecondary, fontSize: fontSize.xs, fontWeight: fontWeight.semibold },
  valueRow: { alignItems: "center", flexDirection: "row", gap: spacing.sm },
  value: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.md,
    color: colors.text,
    flex: 1,
    fontFamily: "monospace",
    fontSize: fontSize.xs,
    padding: spacing.sm,
  },
  copyButton: {
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  copyButtonText: { color: colors.text, fontSize: fontSize.sm },
  error: { color: colors.danger, fontSize: fontSize.sm },
  primaryButton: {
    alignItems: "center",
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    padding: spacing.sm,
  },
  primaryButtonText: {
    color: colors.textInverse,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
  },
});
