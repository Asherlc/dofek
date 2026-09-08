import { statusColors } from "@dofek/scoring/colors";
import { StyleSheet } from "react-native";
import { colors } from "../../theme";

export const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  content: {
    padding: 16,
    paddingBottom: 100,
    gap: 16,
  },
  loadingContainer: {
    flex: 1,
    backgroundColor: colors.background,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
  },
  loadingText: {
    fontSize: 16,
    color: colors.textTertiary,
  },
  chartsLoading: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    padding: 24,
    alignItems: "center",
    gap: 8,
  },
  chartsLoadingText: {
    fontSize: 13,
    color: colors.textTertiary,
  },
  errorContainer: {
    flex: 1,
    backgroundColor: colors.background,
    alignItems: "center",
    justifyContent: "center",
  },
  errorText: {
    fontSize: 16,
    color: colors.textSecondary,
  },
  header: {
    gap: 8,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  icon: {
    fontSize: 32,
  },
  headerText: {
    flex: 1,
    gap: 6,
  },
  name: {
    fontSize: 22,
    fontWeight: "700",
    color: colors.text,
  },
  typeBadge: {
    alignSelf: "flex-start",
    backgroundColor: colors.surfaceSecondary,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  typeBadgeText: {
    fontSize: 12,
    fontWeight: "600",
    color: colors.textSecondary,
    textTransform: "capitalize",
  },
  dateTime: {
    fontSize: 14,
    color: colors.textSecondary,
    marginTop: 4,
  },
  sourceRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    marginTop: 2,
  },
  source: {
    fontSize: 12,
    color: colors.textTertiary,
  },
  sourceLinkRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  sourceLinkPressable: {
    paddingVertical: 2,
    paddingHorizontal: 4,
    borderRadius: 4,
  },
  sourceLink: {
    fontSize: 12,
    color: colors.accent,
    textDecorationLine: "underline",
  },
  sourceRemoved: {
    fontSize: 12,
    color: colors.textTertiary,
    textDecorationLine: "line-through",
  },
  providerAbsentBanner: {
    marginTop: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "rgba(245, 158, 11, 0.35)",
    backgroundColor: "rgba(245, 158, 11, 0.12)",
    padding: 12,
    gap: 10,
  },
  providerAbsentTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: colors.text,
  },
  providerAbsentDetails: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12,
  },
  providerAbsentDetail: {
    minWidth: 90,
    gap: 2,
  },
  providerAbsentLabel: {
    fontSize: 10,
    fontWeight: "700",
    color: colors.textTertiary,
    textTransform: "uppercase",
  },
  providerAbsentValue: {
    fontSize: 12,
    color: colors.text,
  },
  providerAbsentExplanation: {
    fontSize: 11,
    color: colors.textSecondary,
    lineHeight: 16,
  },
  sourceDecisionCard: {
    marginTop: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    padding: 12,
    gap: 10,
  },
  sourceDecisionTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: colors.text,
  },
  sourceDecisionDetails: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12,
  },
  sourceDecisionDetail: {
    minWidth: 90,
    gap: 2,
  },
  sourceDecisionLabel: {
    fontSize: 10,
    fontWeight: "700",
    color: colors.textTertiary,
    textTransform: "uppercase",
  },
  sourceDecisionValue: {
    fontSize: 12,
    color: colors.text,
  },
  sourceDecisionExplanation: {
    fontSize: 11,
    color: colors.textSecondary,
    lineHeight: 16,
  },
  recomputeButton: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: 14,
    alignItems: "center",
    marginTop: 16,
  },
  recomputeButtonPressed: {
    opacity: 0.7,
  },
  recomputeButtonDisabled: {
    opacity: 0.5,
  },
  recomputeButtonText: {
    fontSize: 14,
    fontWeight: "600",
    color: colors.text,
  },
  deleteButton: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: 14,
    alignItems: "center",
    marginTop: 8,
  },
  exportButton: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: 14,
    alignItems: "center",
    marginTop: 16,
  },
  exportButtonPressed: {
    opacity: 0.7,
  },
  exportButtonDisabled: {
    opacity: 0.5,
  },
  exportButtonText: {
    fontSize: 14,
    fontWeight: "600",
    color: colors.text,
  },
  exportModalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.5)",
    justifyContent: "center",
    padding: 24,
  },
  exportModalCard: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    padding: 20,
    gap: 8,
  },
  exportModalTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: colors.text,
  },
  exportModalSubtitle: {
    fontSize: 14,
    color: colors.textSecondary,
    marginBottom: 8,
  },
  exportModalOption: {
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 14,
    backgroundColor: colors.surfaceSecondary,
  },
  exportModalOptionPressed: {
    opacity: 0.7,
  },
  exportModalOptionDisabled: {
    opacity: 0.5,
  },
  exportModalOptionText: {
    fontSize: 15,
    fontWeight: "600",
    color: colors.text,
  },
  exportModalCancel: {
    marginTop: 8,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: "center",
  },
  exportModalCancelText: {
    fontSize: 15,
    fontWeight: "600",
    color: colors.textSecondary,
  },
  deleteButtonPressed: {
    opacity: 0.7,
  },
  deleteButtonDisabled: {
    opacity: 0.5,
  },
  deleteButtonText: {
    fontSize: 14,
    fontWeight: "600",
    color: statusColors.danger,
  },
});
