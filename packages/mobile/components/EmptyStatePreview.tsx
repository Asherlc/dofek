import { StyleSheet, Text, View } from "react-native";
import { colors, radius, spacing } from "../theme";

export interface EmptyStatePreviewContent {
  title: string;
  message: string;
  requirement?: string;
  previewTitle: string;
  previewItems: readonly string[];
  note: string;
}

export function EmptyStatePreview({ content }: { content: EmptyStatePreviewContent }) {
  return (
    <View accessibilityRole="summary" style={styles.container}>
      <Text accessibilityRole="header" style={styles.title}>
        {content.title}
      </Text>
      <Text style={styles.message}>{content.message}</Text>
      {content.requirement ? <Text style={styles.requirement}>{content.requirement}</Text> : null}
      <Text style={styles.previewTitle}>{content.previewTitle}</Text>
      <View style={styles.list}>
        {content.previewItems.map((item) => (
          <View key={item} style={styles.listItem}>
            <Text accessibilityElementsHidden style={styles.bullet}>
              •
            </Text>
            <Text style={styles.itemText}>{item}</Text>
          </View>
        ))}
      </View>
      <Text style={styles.note}>{content.note}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.xl,
    padding: spacing.lg,
  },
  title: {
    color: colors.text,
    fontSize: 16,
    fontWeight: "700",
    textAlign: "center",
  },
  message: {
    color: colors.textSecondary,
    fontSize: 14,
    lineHeight: 20,
    marginTop: spacing.xs,
    textAlign: "center",
  },
  requirement: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "600",
    lineHeight: 20,
    marginTop: spacing.md,
    textAlign: "center",
  },
  previewTitle: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "700",
    marginTop: spacing.lg,
  },
  list: {
    gap: spacing.xs,
    marginTop: spacing.sm,
  },
  listItem: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: spacing.sm,
  },
  bullet: {
    color: colors.textTertiary,
    fontSize: 14,
    lineHeight: 20,
  },
  itemText: {
    color: colors.textSecondary,
    flex: 1,
    fontSize: 14,
    lineHeight: 20,
  },
  note: {
    color: colors.textTertiary,
    fontSize: 12,
    lineHeight: 18,
    marginTop: spacing.md,
  },
});
