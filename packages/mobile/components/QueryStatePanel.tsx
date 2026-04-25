import type { StyleProp, ViewStyle } from "react-native";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { colors, radius, spacing } from "../theme";

export type QueryStateVariant = "loading" | "error" | "empty";

interface QueryStatePanelProps {
  variant: QueryStateVariant;
  message: string;
  title?: string;
  minHeight?: number;
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
    >
      <Text style={styles.title}>{resolvedTitle}</Text>
      <Text
        style={[styles.message, variant === "error" ? styles.errorMessage : styles.emptyMessage]}
      >
        {message}
      </Text>
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
    backgroundColor: "#3b1212",
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
  errorMessage: {
    color: "#fca5a5",
  },
  emptyMessage: {
    color: colors.textSecondary,
  },
});
