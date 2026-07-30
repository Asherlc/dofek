import { operationalStatusColors } from "@dofek/scoring/colors";
import { fontSize, fontWeight } from "@dofek/scoring/tokens";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { radius, spacing } from "../theme";

interface ReportRecoveryPanelProps {
  message: string;
  onRetry: () => void;
  onReviewData: () => void;
  preserved?: boolean;
  retrying?: boolean;
}

export function ReportRecoveryPanel({
  message,
  onRetry,
  onReviewData,
  preserved = false,
  retrying = false,
}: ReportRecoveryPanelProps) {
  return (
    <View accessibilityLiveRegion="assertive" accessibilityRole="alert" style={styles.panel}>
      <Text style={styles.title}>
        {preserved ? "Showing the last available report" : "Report unavailable"}
      </Text>
      <Text style={styles.message}>{message}</Text>
      <View style={styles.actions}>
        <Pressable
          accessibilityLabel={retrying ? "Retrying..." : "Retry report"}
          accessibilityRole="button"
          accessibilityState={{ disabled: retrying }}
          disabled={retrying}
          onPress={retrying ? undefined : onRetry}
          style={styles.action}
        >
          <Text style={styles.actionText}>{retrying ? "Retrying..." : "Retry report"}</Text>
        </Pressable>
        <Pressable
          accessibilityLabel="Review data alerts"
          accessibilityRole="button"
          onPress={onReviewData}
          style={styles.action}
        >
          <Text style={styles.actionText}>Review data alerts</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    backgroundColor: operationalStatusColors.danger.surface,
    borderColor: operationalStatusColors.danger.border,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.xs,
    padding: spacing.md,
  },
  title: {
    color: operationalStatusColors.danger.foreground,
    fontSize: fontSize.base,
    fontWeight: fontWeight.bold,
  },
  message: {
    color: operationalStatusColors.danger.foreground,
    fontSize: fontSize.sm,
    lineHeight: 20,
  },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  action: {
    borderColor: operationalStatusColors.danger.border,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  actionText: {
    color: operationalStatusColors.danger.foreground,
    fontSize: fontSize.xs,
    fontWeight: fontWeight.bold,
  },
});
