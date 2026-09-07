import {
  type DeveloperClientInput,
  DeveloperClientInputSchema,
} from "@dofek/auth/developer-clients";
import { useRef, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import type { z } from "zod";
import { colors, fontSize, fontWeight, radius, spacing } from "../theme";

interface DeveloperClientFormProps {
  disabled?: boolean;
  error?: string | null;
  initialValue?: { name: string; redirectUris: string[] };
  isSubmitting?: boolean;
  onSubmit: (input: DeveloperClientInput) => Promise<void> | void;
  submitLabel?: string;
}

export function DeveloperClientForm({
  disabled = false,
  error,
  initialValue,
  isSubmitting = false,
  onSubmit,
  submitLabel = "Create integration",
}: DeveloperClientFormProps) {
  const [name, setName] = useState(initialValue?.name ?? "");
  const nextRedirectId = useRef(initialValue?.redirectUris.length ?? 1);
  const [redirects, setRedirects] = useState(() =>
    (initialValue?.redirectUris ?? [""]).map((value, id) => ({ id, value })),
  );
  const [validationIssues, setValidationIssues] = useState<z.core.$ZodIssue[]>([]);

  function submit(): void {
    const parsed = DeveloperClientInputSchema.safeParse({
      name,
      redirectUris: redirects.map((redirect) => redirect.value),
      scopes: ["nutrition:write"],
    });
    if (!parsed.success) {
      setValidationIssues(parsed.error.issues);
      return;
    }
    setValidationIssues([]);
    void onSubmit(parsed.data);
  }

  function updateRedirect(index: number, value: string): void {
    setRedirects((current) =>
      current.map((redirect, currentIndex) =>
        currentIndex === index ? { ...redirect, value } : redirect,
      ),
    );
    setValidationIssues([]);
  }

  return (
    <View style={styles.container} accessibilityLabel="Developer integration">
      <Text style={styles.label}>Integration name</Text>
      <TextInput
        accessibilityLabel="Integration name"
        editable={!disabled}
        onChangeText={(value) => {
          setName(value);
          setValidationIssues([]);
        }}
        placeholder="Meal importer"
        placeholderTextColor={colors.textTertiary}
        style={styles.input}
        value={name}
      />

      <Text style={styles.label}>HTTPS redirect URIs</Text>
      {redirects.map((redirect, index) => (
        <View key={redirect.id} style={styles.redirectRow}>
          <TextInput
            accessibilityLabel={`Redirect URI ${index + 1}`}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!disabled}
            keyboardType="url"
            onChangeText={(value) => updateRedirect(index, value)}
            placeholder="https://integration.example/callback"
            placeholderTextColor={colors.textTertiary}
            style={[styles.input, styles.redirectInput]}
            value={redirect.value}
          />
          <TouchableOpacity
            accessibilityLabel={`Remove redirect URI ${index + 1}`}
            accessibilityRole="button"
            accessibilityState={{ disabled: disabled || redirects.length === 1 }}
            disabled={disabled || redirects.length === 1}
            onPress={() =>
              setRedirects((current) =>
                current.length === 1
                  ? current
                  : current.filter((_, currentIndex) => currentIndex !== index),
              )
            }
            style={styles.secondaryButton}
          >
            <Text style={styles.secondaryButtonText}>Remove</Text>
          </TouchableOpacity>
        </View>
      ))}
      <TouchableOpacity
        accessibilityLabel="Add redirect URI"
        accessibilityRole="button"
        accessibilityState={{ disabled }}
        disabled={disabled}
        onPress={() => {
          const id = nextRedirectId.current;
          nextRedirectId.current += 1;
          setRedirects((current) => [...current, { id, value: "" }]);
        }}
        style={styles.secondaryButton}
      >
        <Text style={styles.secondaryButtonText}>Add redirect URI</Text>
      </TouchableOpacity>

      <Text style={styles.label}>Scope</Text>
      <Pressable
        accessibilityLabel="nutrition:write"
        accessibilityRole="checkbox"
        accessibilityState={{ checked: true, disabled: true }}
        disabled
        style={styles.scopeRow}
      >
        <Text style={styles.checkbox}>✓</Text>
        <Text style={styles.monospace}>nutrition:write</Text>
      </Pressable>

      {validationIssues.map((issue) => (
        <Text
          key={`${issue.code}-${issue.path.join(".")}-${issue.message}`}
          accessibilityRole="alert"
          style={styles.error}
        >
          {issue.message}
        </Text>
      ))}
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}

      <TouchableOpacity
        accessibilityLabel={submitLabel}
        accessibilityRole="button"
        accessibilityState={{ disabled: disabled || isSubmitting }}
        disabled={disabled || isSubmitting}
        onPress={submit}
        style={styles.primaryButton}
      >
        <Text style={styles.primaryButtonText}>{isSubmitting ? "Saving…" : submitLabel}</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: spacing.sm },
  label: { color: colors.text, fontSize: fontSize.sm, fontWeight: fontWeight.semibold },
  input: {
    backgroundColor: colors.surfaceSecondary,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    color: colors.text,
    fontSize: fontSize.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  redirectRow: { alignItems: "center", flexDirection: "row", gap: spacing.xs },
  redirectInput: { flex: 1 },
  secondaryButton: {
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  secondaryButtonText: { color: colors.textSecondary, fontSize: fontSize.sm },
  scopeRow: { alignItems: "center", flexDirection: "row", gap: spacing.sm },
  checkbox: { color: colors.accent, fontSize: fontSize.base },
  monospace: { color: colors.textSecondary, fontFamily: "monospace", fontSize: fontSize.sm },
  error: { color: colors.danger, fontSize: fontSize.sm },
  primaryButton: {
    alignItems: "center",
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  primaryButtonText: {
    color: colors.textInverse,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
  },
});
