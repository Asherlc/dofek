import type { ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import { colors, radius, spacing } from "../theme";

interface CardProps {
  children: ReactNode;
  /** Optional uppercase section title rendered above the content */
  title?: string;
}

export function Card({ children, title }: CardProps) {
  return (
    <View style={styles.card}>
      {title != null && (
        <Text testID="card-title" style={styles.title}>
          {title.toUpperCase()}
        </Text>
      )}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
    padding: spacing.md,
    gap: spacing.sm + 4, // 12 — matches existing card gap
  },
  title: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.textSecondary,
    letterSpacing: 0.5,
  },
});
