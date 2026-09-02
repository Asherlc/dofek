import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors, radius, spacing } from "../theme";

interface PaginationControlsProps {
  page: number;
  pageSize: number;
  totalItems: number;
  itemLabel: string;
  onPageChange: (page: number) => void;
}

export function PaginationControls({
  page,
  pageSize,
  totalItems,
  itemLabel,
  onPageChange,
}: PaginationControlsProps) {
  const totalPages = Math.ceil(totalItems / pageSize);
  if (totalPages <= 1) return null;

  const currentPage = Math.min(Math.max(page, 0), totalPages - 1);

  return (
    <View style={styles.container}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Previous ${itemLabel} page`}
        accessibilityState={{ disabled: currentPage === 0 }}
        disabled={currentPage === 0}
        onPress={() => onPageChange(currentPage - 1)}
        style={[styles.button, currentPage === 0 ? styles.buttonDisabled : null]}
      >
        <Text style={styles.buttonText}>Previous</Text>
      </Pressable>
      <Text style={styles.status}>
        {currentPage + 1} / {totalPages}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Next ${itemLabel} page`}
        accessibilityState={{ disabled: currentPage === totalPages - 1 }}
        disabled={currentPage === totalPages - 1}
        onPress={() => onPageChange(currentPage + 1)}
        style={[styles.button, currentPage === totalPages - 1 ? styles.buttonDisabled : null]}
      >
        <Text style={styles.buttonText}>Next</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: "center",
    borderTopColor: colors.surfaceSecondary,
    borderTopWidth: 1,
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: spacing.sm,
    paddingTop: spacing.md,
  },
  button: {
    borderColor: colors.surfaceSecondary,
    borderRadius: radius.md,
    borderWidth: 1,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  buttonDisabled: {
    opacity: 0.35,
  },
  buttonText: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "600",
  },
  status: {
    color: colors.textSecondary,
    fontSize: 12,
    fontVariant: ["tabular-nums"],
  },
});
