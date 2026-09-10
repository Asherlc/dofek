import { StyleSheet } from "react-native";
import { colors } from "../../theme";

export const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  content: {
    padding: 16,
    paddingTop: 24,
    paddingBottom: 40,
  },
  loadingContainer: {
    flex: 1,
    backgroundColor: colors.background,
    justifyContent: "center",
    alignItems: "center",
  },

  fullSyncLink: {
    fontSize: 13,
    color: colors.accent,
    marginTop: 4,
  },
  // Sync All buttons
  syncAllRow: {
    flexDirection: "row",
    gap: 8,
    marginBottom: 20,
  },
  syncAllButton: {
    backgroundColor: colors.accent,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
  },
  syncAllButtonFlex: {
    flex: 1,
  },
  syncAllButtonDisabled: {
    opacity: 0.5,
  },
  syncAllButtonText: {
    color: colors.text,
    fontSize: 16,
    fontWeight: "600",
  },
  fullSyncAllButton: {
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 16,
    alignItems: "center",
    borderWidth: 1,
    borderColor: colors.accent,
  },
  fullSyncAllButtonText: {
    color: colors.accent,
    fontSize: 16,
    fontWeight: "600",
  },
  shareInfoCard: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    padding: 16,
    marginBottom: 12,
  },
  shareInfoTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: colors.text,
    marginBottom: 4,
  },
  shareInfoDescription: {
    fontSize: 13,
    color: colors.textSecondary,
    lineHeight: 19,
  },
  shareImportState: {
    marginTop: 10,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.surfaceSecondary,
  },
  shareImportTitle: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.text,
    textTransform: "capitalize",
  },
  shareImportMessage: {
    fontSize: 12,
    color: colors.textSecondary,
    marginTop: 4,
  },
  shareImportError: {
    color: colors.danger,
  },
  // Section titles
  sectionTitle: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.textSecondary,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 10,
  },
  providerFamilyHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 6,
    paddingHorizontal: 4,
  },
  providerFamilyTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: colors.text,
  },
  providerFamilyMethods: {
    flexDirection: "row",
    gap: 4,
  },
  providerFamilyMethod: {
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 5,
  },
  providerFamilyMethodSelected: {
    backgroundColor: colors.surfaceSecondary,
  },
  providerFamilyMethodText: {
    fontSize: 12,
    color: colors.textSecondary,
  },

  // Provider cards
  card: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    padding: 16,
    marginBottom: 12,
  },
  cardHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  cardTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flex: 1,
    minWidth: 0,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: colors.text,
  },
  cardActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  cardMeta: {
    marginTop: 6,
    gap: 2,
  },
  cardMetaText: {
    fontSize: 13,
    color: colors.textSecondary,
  },
  syncButton: {
    backgroundColor: colors.accent,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    minWidth: 60,
  },
  syncButtonDisabled: {
    opacity: 0.5,
  },
  syncButtonText: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "600",
  },

  // Sync progress
  syncProgressContainer: {
    marginTop: 8,
    gap: 4,
  },
  syncProgressFailedCount: {
    fontSize: 12,
    color: colors.warning,
    marginTop: 2,
  },

  // Sync history logs
  logRow: {
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.surfaceSecondary,
  },
  logLeft: {
    gap: 4,
  },
  logTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  logProvider: {
    fontSize: 14,
    fontWeight: "600",
    color: colors.text,
  },
  logDataType: {
    fontSize: 13,
    color: colors.textSecondary,
  },
  logDetails: {
    flexDirection: "row",
    gap: 12,
    marginTop: 2,
  },
  logDetailText: {
    fontSize: 12,
    color: colors.textTertiary,
  },
  logError: {
    fontSize: 12,
    color: colors.danger,
    marginTop: 4,
  },
  emptyText: {
    fontSize: 14,
    color: colors.textTertiary,
    textAlign: "center",
    paddingVertical: 8,
  },

  // Credential Auth Modal
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.6)",
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  modalContent: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    padding: 20,
    width: "100%",
    maxWidth: 340,
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 16,
  },
  modalTitle: {
    fontSize: 16,
    fontWeight: "600",
    color: colors.text,
  },
  modalClose: {
    fontSize: 22,
    color: colors.textSecondary,
    paddingHorizontal: 4,
  },
  modalDescription: {
    fontSize: 13,
    color: colors.accent,
    marginBottom: 12,
  },
  errorBanner: {
    backgroundColor: "rgba(239, 68, 68, 0.1)",
    borderRadius: 8,
    padding: 10,
    marginBottom: 12,
  },
  errorText: {
    fontSize: 13,
    color: colors.danger,
  },
  input: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    color: colors.text,
    marginBottom: 10,
  },
  signInButton: {
    backgroundColor: colors.accent,
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 4,
  },
  signInButtonDisabled: {
    backgroundColor: colors.surfaceSecondary,
  },
  signInButtonText: {
    color: colors.text,
    fontSize: 15,
    fontWeight: "600",
  },
  signInButtonTextDisabled: {
    color: colors.textSecondary,
  },
  disabledHint: {
    color: colors.textSecondary,
    fontSize: 12,
    marginTop: 4,
  },

  // WHOOP verify step
  verifyDescription: {
    fontSize: 14,
    color: colors.textSecondary,
    marginBottom: 12,
  },
  savingContainer: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    paddingVertical: 16,
  },
  savingText: {
    fontSize: 14,
    color: colors.textSecondary,
  },

  // HealthKit permission update banner
  permissionBanner: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    marginTop: -4,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: colors.accent,
  },
  permissionBannerText: {
    fontSize: 13,
    color: colors.accent,
    textAlign: "center",
  },
});
