import { StyleSheet } from "react-native";
import { colors, radius, spacing } from "../theme";

export const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  content: {
    padding: spacing.md,
    gap: spacing.md,
  },
  backgroundErrorPanel: {
    marginBottom: spacing.md,
  },
  trainingSummary: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.lg,
    borderWidth: 1,
  },
  summaryButton: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.sm,
  },
  summaryTitle: {
    flex: 1,
    color: colors.text,
    fontWeight: "700",
  },
  summaryMeta: {
    color: colors.textSecondary,
    fontSize: 12,
    flexShrink: 1,
  },
  controlsPanel: {
    gap: spacing.sm,
  },
  controlsHeader: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: spacing.sm,
  },
  selectButton: {
    borderColor: colors.surfaceSecondary,
    borderRadius: radius.md,
    borderWidth: 1,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  selectButtonText: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "600",
  },
  selectionGuidance: {
    color: colors.textSecondary,
    fontSize: 12,
  },
  bulkActionRow: {
    alignItems: "center",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
  },
  selectedCount: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "600",
  },
  deleteSelectionButton: {
    backgroundColor: colors.danger,
    borderRadius: radius.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  deleteSelectionButtonText: {
    color: "#fff",
    fontSize: 12,
    fontWeight: "700",
  },
  cancelSelectionButton: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  cancelSelectionButtonText: {
    color: colors.text,
    fontSize: 12,
    fontWeight: "600",
  },
  disabledAction: {
    opacity: 0.5,
  },
  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.xs,
  },
  filterRow: { flexDirection: "row", gap: spacing.sm },
  filterButton: { flex: 1 },
  filterChip: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    paddingHorizontal: spacing.sm,
    minHeight: 44,
    justifyContent: "center",
  },
  filterChipText: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "600",
  },
  filterCurrent: { color: colors.accent },
  daySection: {
    gap: spacing.sm,
  },
  dayHeaderRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
  },
  dayHeader: {
    color: colors.textSecondary,
    fontSize: 13,
    fontWeight: "600",
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  dayHeaderRule: {
    backgroundColor: colors.surfaceSecondary,
    flex: 1,
    height: 1,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    overflow: "hidden",
  },
  cardSelected: {
    borderColor: colors.accent,
    borderWidth: 1,
  },
  cardAction: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  },
  cardContent: {
    flexDirection: "row",
    gap: spacing.sm,
    padding: spacing.sm,
  },
  cardMain: {
    flex: 1,
    minWidth: 0,
    padding: spacing.xs,
  },
  titleRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.xs,
  },
  activityName: {
    color: colors.text,
    flex: 1,
    fontSize: 15,
    fontWeight: "600",
  },
  typePill: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.sm,
    color: colors.textSecondary,
    fontSize: 11,
    fontWeight: "600",
    overflow: "hidden",
    paddingHorizontal: spacing.xs,
    paddingVertical: 2,
  },
  selectionPill: {
    borderColor: colors.surfaceSecondary,
    borderRadius: radius.sm,
    borderWidth: 1,
    color: colors.textSecondary,
    fontSize: 11,
    fontWeight: "600",
    overflow: "hidden",
    paddingHorizontal: spacing.xs,
    paddingVertical: 2,
  },
  selectionPillSelected: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
    color: "#fff",
  },
  activityMeta: {
    color: colors.textSecondary,
    fontSize: 12,
    marginTop: 2,
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    flexWrap: "wrap",
  },
  mapPanel: {
    paddingHorizontal: spacing.sm,
    paddingBottom: spacing.sm,
  },
});
