import { statusColors } from "@dofek/scoring/colors";
import { StyleSheet } from "react-native";
import { colors } from "../../theme";

export const statsStyles = StyleSheet.create({
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    rowGap: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingTop: 16,
  },
  card: {
    paddingRight: 12,
    width: "48%",
    minWidth: 130,
    flexGrow: 1,
  },
  label: {
    fontSize: 11,
    color: colors.textTertiary,
    marginBottom: 4,
  },
  value: {
    fontSize: 22,
    fontWeight: "700",
    color: colors.text,
    fontVariant: ["tabular-nums"],
  },
  secondary: { color: colors.textSecondary, fontSize: 12, marginTop: 4 },
});

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
  mapProcessing: {
    height: 280,
    borderRadius: 12,
    overflow: "hidden",
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
