import { operationalStatusColors } from "@dofek/scoring/colors";
import type { StyleProp, ViewStyle } from "react-native";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { colors, radius, spacing } from "../theme";

export type QueryStateVariant = "loading" | "error" | "empty";

interface QueryStatePanelProps {
  variant: QueryStateVariant;
  message?: string;
  title?: string;
  minHeight?: number;
  onRetry?: () => void;
  retryLabel?: string;
  retrying?: boolean;
  style?: StyleProp<ViewStyle>;
}

export function getQueryErrorMessage(
  error: unknown,
  fallback = "Could not load this section.",
): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }
  return fallback;
}

export function QueryStatePanel({
  variant,
  message,
  title,
  minHeight = 120,
  onRetry,
  retryLabel = "Retry",
  retrying = false,
  style,
}: QueryStatePanelProps) {
  if (variant === "loading") {
    return (
      <View testID="query-state-loading" style={[styles.panel, { minHeight }, style]}>
        <ActivityIndicator color={colors.accent} size="small" />
      </View>
    );
  }

  const resolvedTitle =
    title ?? (variant === "error" ? "Could not load this section" : "No data yet");

  return (
    <View
      testID={`query-state-${variant}`}
      style={[
        styles.panel,
        { minHeight },
        variant === "error" ? styles.errorPanel : styles.emptyPanel,
        style,
      ]}
      accessibilityLiveRegion={variant === "error" ? "assertive" : "polite"}
      accessibilityRole={variant === "error" ? "alert" : "summary"}
    >
      {variant === "error" ? (
        <Text
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={styles.errorIcon}
          testID="query-state-error-icon"
        >
          !
        </Text>
      ) : null}
      <Text style={[styles.title, variant === "error" ? styles.errorText : null]}>
        {resolvedTitle}
      </Text>
      {message ? (
        <Text
          style={[styles.message, variant === "error" ? styles.errorText : styles.emptyMessage]}
        >
          {message}
        </Text>
      ) : null}
      {onRetry ? (
        <Pressable
          accessibilityLabel={retrying ? "Retrying..." : retryLabel}
          accessibilityRole="button"
          accessibilityState={{ disabled: retrying }}
          disabled={retrying}
          onPress={retrying ? undefined : onRetry}
          style={styles.retryButton}
        >
          <Text style={styles.retryText}>{retrying ? "Retrying..." : retryLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.xl,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.lg,
    gap: spacing.xs,
  },
  errorPanel: {
    backgroundColor: operationalStatusColors.danger.surface,
    borderColor: operationalStatusColors.danger.border,
    borderWidth: 1,
  },
  emptyPanel: {
    backgroundColor: colors.surfaceSecondary,
  },
  title: {
    fontSize: 14,
    fontWeight: "700",
    color: colors.text,
    textAlign: "center",
  },
  message: {
    fontSize: 13,
    textAlign: "center",
  },
  errorText: {
    color: operationalStatusColors.danger.foreground,
  },
  errorIcon: {
    borderColor: operationalStatusColors.danger.border,
    borderRadius: radius.full,
    borderWidth: 1,
    color: operationalStatusColors.danger.foreground,
    fontSize: 14,
    fontWeight: "800",
    height: 24,
    lineHeight: 22,
    textAlign: "center",
    width: 24,
  },
  emptyMessage: {
    color: colors.textSecondary,
  },
  retryButton: {
    backgroundColor: operationalStatusColors.danger.surface,
    borderColor: operationalStatusColors.danger.border,
    borderRadius: radius.md,
    borderWidth: 1,
    marginTop: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  retryText: {
    color: operationalStatusColors.danger.foreground,
    fontSize: 12,
    fontWeight: "700",
  },
});
