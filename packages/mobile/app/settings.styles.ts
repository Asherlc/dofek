import { StyleSheet } from "react-native";
import { colors } from "../theme";

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
  contentWide: {
    maxWidth: 600,
    alignSelf: "center",
    width: "100%",
  },

  // ── Search ──
  searchInput: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    color: colors.text,
    fontSize: 15,
    marginBottom: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  noSearchResults: {
    color: colors.textTertiary,
    fontSize: 14,
    marginBottom: 24,
  },

  // ── Tabs ──
  tabsScrollView: {
    marginBottom: 24,
  },
  tabs: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: 4,
    gap: 4,
  },
  tab: {
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  tabSelected: {
    backgroundColor: colors.surfaceSecondary,
  },
  tabText: {
    color: colors.textSecondary,
    fontSize: 14,
    fontWeight: "500",
  },
  tabTextSelected: {
    color: colors.text,
    fontWeight: "600",
  },

  // ── Sections ──
  section: {
    marginBottom: 24,
  },
  healthTrackingCards: {
    gap: 8,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.textSecondary,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 2,
  },
  sectionDescription: {
    fontSize: 13,
    color: colors.textTertiary,
    marginBottom: 10,
  },
  label: {
    color: colors.textSecondary,
    fontSize: 13,
    marginBottom: 6,
  },

  // ── Billing ──
  billingStatusText: {
    color: colors.text,
    fontSize: 14,
    marginBottom: 8,
  },
  billingDetailText: {
    color: colors.textSecondary,
    fontSize: 13,
    marginBottom: 8,
  },
  billingErrorText: {
    color: colors.danger,
    fontSize: 12,
    marginBottom: 8,
  },
  billingActionRow: {
    flexDirection: "column",
    gap: 10,
  },
  billingPrimaryButton: {
    backgroundColor: colors.accent,
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: "center",
  },
  billingSecondaryButton: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: "center",
  },
  billingButtonText: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "600",
  },
  buttonDisabled: {
    opacity: 0.5,
  },

  // ── Card ──
  card: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    padding: 16,
  },
  emptyText: {
    fontSize: 14,
    color: colors.textTertiary,
  },

  // ── Data Sources ──
  dataSourcesRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  dataSourcesInfo: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  providerLogos: {
    flexDirection: "row",
    gap: 6,
  },
  dataSourcesCount: {
    fontSize: 14,
    color: colors.textSecondary,
  },

  // ── Toggle Row ──
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  toggleInfo: {
    flex: 1,
    marginRight: 12,
  },
  toggleLabel: {
    fontSize: 15,
    fontWeight: "600",
    color: colors.text,
  },
  toggleDescription: {
    fontSize: 13,
    color: colors.textTertiary,
    marginTop: 2,
  },

  // ── Unit System ──
  unitRow: {
    flexDirection: "row",
    gap: 10,
  },
  unitButton: {
    flex: 1,
    backgroundColor: colors.surface,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: colors.surfaceSecondary,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  unitButtonSelected: {
    borderColor: colors.accent,
    backgroundColor: colors.accentSubtle,
  },
  unitLabel: {
    fontSize: 15,
    fontWeight: "600",
    color: colors.textSecondary,
  },
  unitLabelSelected: {
    color: colors.text,
  },
  unitDescription: {
    fontSize: 12,
    color: colors.textTertiary,
    marginTop: 2,
  },
  unitErrorText: {
    color: colors.danger,
    fontSize: 12,
    marginBottom: 8,
  },

  // ── Goal Weight ──
  goalEditRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  goalInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    color: colors.text,
    fontSize: 14,
  },
  goalSaveButton: {
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  goalSaveText: {
    color: colors.blue,
    fontSize: 14,
    fontWeight: "600",
  },
  goalCancelText: {
    color: colors.textSecondary,
    fontSize: 14,
    paddingHorizontal: 8,
  },
  goalDisplayRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  goalDisplayText: {
    color: colors.text,
    fontSize: 16,
    fontWeight: "600",
  },
  goalEditText: {
    color: colors.blue,
    fontSize: 14,
    fontWeight: "600",
  },

  // ── Developer Tools ──
  devToolRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.surfaceSecondary,
  },
  devToolRowLast: {
    borderBottomWidth: 0,
  },
  devToolLabel: {
    fontSize: 15,
    fontWeight: "500",
    color: colors.text,
  },
  devToolChevron: {
    fontSize: 18,
    color: colors.textTertiary,
  },
  devToolDetail: {
    fontSize: 11,
    color: colors.textTertiary,
    marginTop: 2,
    fontVariant: ["tabular-nums"],
  },

  // ── Danger Zone ──
  dangerCard: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.danger,
  },
  deleteButton: {
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: colors.danger,
    paddingVertical: 12,
    alignItems: "center",
  },
  deleteButtonDisabled: {
    opacity: 0.6,
  },
  deleteButtonText: {
    fontSize: 14,
    fontWeight: "600",
    color: colors.danger,
  },

  // ── Password ──
  passwordInputContainer: {
    alignItems: "center",
    backgroundColor: colors.surfaceSecondary,
    borderRadius: 12,
    flexDirection: "row",
    marginBottom: 10,
  },
  passwordInput: {
    color: colors.text,
    flex: 1,
    fontSize: 15,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  passwordVisibilityButton: {
    alignItems: "center",
    alignSelf: "stretch",
    justifyContent: "center",
    paddingHorizontal: 14,
  },
  passwordVisibilityText: {
    color: colors.textSecondary,
    fontSize: 13,
    fontWeight: "600",
  },
  passwordRequirementText: {
    color: colors.textTertiary,
    fontSize: 12,
    marginBottom: 8,
  },
  passwordErrorText: {
    color: colors.danger,
    fontSize: 12,
    marginBottom: 8,
  },
  passwordButton: {
    alignItems: "center",
    backgroundColor: colors.accent,
    borderRadius: 12,
    paddingVertical: 12,
  },
  passwordButtonText: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "600",
  },

  // ── Logout ──
  logoutButton: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: colors.danger,
    paddingVertical: 14,
    alignItems: "center",
  },
  logoutText: {
    fontSize: 16,
    fontWeight: "600",
    color: colors.danger,
  },
});
