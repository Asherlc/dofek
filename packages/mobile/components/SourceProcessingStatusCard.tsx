import type { ProcessingDisplayStatus } from "@dofek/providers/processing-status";
import { operationalStatusColors } from "@dofek/scoring/colors";
import { type ReactNode, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors, radius, spacing } from "../theme";

interface SourceProcessingStatusCardProps {
  contextLabel?: string;
  heading: string;
  message: string | null;
  progress: number | null;
  status: ProcessingDisplayStatus;
  tone?: "success" | "warning" | "danger" | "neutral";
  children?: ReactNode;
  details?: ReactNode;
}

export function SourceProcessingStatusCard({
  contextLabel,
  heading,
  message,
  progress,
  status,
  tone,
  children,
  details,
}: SourceProcessingStatusCardProps) {
  const [detailsExpanded, setDetailsExpanded] = useState(false);

  return (
    <View
      style={[
        styles.container,
        tone
          ? { borderLeftColor: operationalStatusColors[tone].indicator }
          : borderStyleByStatus[status],
      ]}
      accessibilityRole="summary"
      accessibilityLiveRegion={status === "active" || status === "partial" ? "polite" : "none"}
    >
      {contextLabel ? <Text style={styles.contextLabel}>{contextLabel}</Text> : null}
      <View style={styles.header}>
        <Text style={styles.heading}>{heading}</Text>
        {details ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              detailsExpanded ? "Hide processing details" : "Show processing details"
            }
            aria-expanded={detailsExpanded}
            hitSlop={6}
            onPress={() => setDetailsExpanded((expanded) => !expanded)}
            style={styles.detailsToggle}
          >
            <Text style={styles.detailsLabel}>Details {detailsExpanded ? "▾" : "▸"}</Text>
          </Pressable>
        ) : null}
      </View>
      {message ? <Text style={styles.message}>{message}</Text> : null}
      {children}
      {detailsExpanded ? details : null}
      {progress !== null && status !== "ready" ? (
        <View
          style={styles.progressTrack}
          testID="processing-status-progress"
          accessibilityRole="progressbar"
          accessibilityLabel="Processing progress"
          accessibilityValue={{ min: 0, max: 100, now: progress }}
        >
          <View style={[styles.progressFill, { width: `${progress}%` }]} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.surface,
    borderColor: colors.surfaceSecondary,
    borderLeftWidth: 4,
    borderRadius: radius.lg,
    borderWidth: 1,
    gap: spacing.xs,
    padding: spacing.sm,
  },
  contextLabel: {
    color: colors.textSecondary,
    fontSize: 11,
    fontWeight: "700",
    textTransform: "uppercase",
  },
  header: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
    justifyContent: "space-between",
  },
  heading: { color: colors.text, flex: 1, fontSize: 14, fontWeight: "700" },
  detailsToggle: { justifyContent: "center", minHeight: 32, paddingHorizontal: spacing.xs },
  detailsLabel: { color: colors.textSecondary, fontSize: 12 },
  message: { color: colors.textSecondary, fontSize: 12, lineHeight: 17 },
  progressTrack: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.full,
    height: 6,
    marginTop: spacing.xs,
    overflow: "hidden",
  },
  progressFill: { backgroundColor: operationalStatusColors.info.indicator, height: 6 },
});

const borderStyleByStatus = StyleSheet.create({
  ready: { borderLeftColor: operationalStatusColors.success.indicator },
  waiting: { borderLeftColor: operationalStatusColors.info.indicator },
  active: { borderLeftColor: operationalStatusColors.info.indicator },
  partial: { borderLeftColor: operationalStatusColors.info.indicator },
  delayed: { borderLeftColor: operationalStatusColors.warning.indicator },
  blocked: { borderLeftColor: operationalStatusColors.warning.indicator },
  failed: { borderLeftColor: operationalStatusColors.danger.indicator },
  cancelled: { borderLeftColor: operationalStatusColors.neutral.indicator },
});
