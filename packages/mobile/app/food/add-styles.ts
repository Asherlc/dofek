import { StyleSheet } from "react-native";
import { colors } from "../../theme";

export const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  scrollView: {
    flex: 1,
  },
  resultsContent: {
    paddingBottom: 24,
  },
  formContent: {
    padding: 16,
    paddingBottom: 40,
  },
  contentWide: {
    maxWidth: 600,
    alignSelf: "center",
    width: "100%",
  },

  // ── Tab ribbon ──
  ribbon: {
    flexDirection: "row",
    backgroundColor: colors.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.surfaceSecondary,
    paddingHorizontal: 8,
  },
  ribbonTab: {
    flex: 1,
    paddingVertical: 12,
    alignItems: "center",
    borderBottomWidth: 2,
    borderBottomColor: "transparent",
  },
  ribbonTabActive: {
    borderBottomColor: colors.accent,
  },
  ribbonTabText: {
    fontSize: 15,
    fontWeight: "600",
    color: colors.textSecondary,
  },
  ribbonTabTextActive: {
    color: colors.accent,
  },

  // ── Search bar ──
  searchBar: {
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 10,
    backgroundColor: colors.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.surfaceSecondary,
  },
  searchInput: {
    backgroundColor: colors.background,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    fontSize: 16,
    color: colors.text,
    borderWidth: 1,
    borderColor: colors.surfaceSecondary,
  },

  // ── Search results ──
  sectionHeader: {
    fontSize: 12,
    fontWeight: "600",
    color: colors.textSecondary,
    textTransform: "uppercase",
    letterSpacing: 0.7,
    paddingHorizontal: 14,
    paddingTop: 14,
    paddingBottom: 10,
  },
  loadingRow: {
    paddingVertical: 20,
    alignItems: "center",
  },
  resultCard: {
    marginHorizontal: 14,
    marginBottom: 10,
    padding: 14,
    backgroundColor: colors.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.surfaceSecondary,
  },
  resultHeaderRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
  },
  resultName: {
    flex: 1,
    fontSize: 16,
    lineHeight: 22,
    color: colors.text,
    fontWeight: "600",
  },
  resultCaloriesBadge: {
    backgroundColor: colors.background,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.surfaceSecondary,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  resultCaloriesText: {
    fontSize: 12,
    fontWeight: "700",
    color: colors.text,
  },
  resultServing: {
    fontSize: 13,
    color: colors.textTertiary,
    marginTop: 6,
    lineHeight: 18,
  },
  resultMetaRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 12,
    gap: 10,
  },
  resultMacroTags: {
    flex: 1,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  resultMacroTag: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: colors.background,
  },
  resultMacroTagText: {
    fontSize: 11,
    color: colors.textSecondary,
    fontWeight: "600",
  },
  resultSource: {
    fontSize: 11,
    color: colors.textTertiary,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  emptyText: {
    textAlign: "center",
    color: colors.textTertiary,
    paddingVertical: 28,
    paddingHorizontal: 18,
  },
  manualEntry: {
    marginHorizontal: 14,
    marginTop: 6,
    paddingVertical: 14,
    paddingHorizontal: 14,
    alignItems: "center",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.accent,
    backgroundColor: colors.surface,
  },
  manualEntryText: {
    fontSize: 15,
    color: colors.accent,
    fontWeight: "500",
  },
  searchDatabaseButton: {
    marginHorizontal: 14,
    marginTop: 10,
    paddingVertical: 14,
    paddingHorizontal: 14,
    alignItems: "center",
    borderRadius: 12,
    backgroundColor: colors.accent,
  },
  searchDatabaseButtonText: {
    fontSize: 15,
    color: colors.text,
    fontWeight: "600",
  },

  // ── Scanning overlay ──
  scanningOverlay: {
    paddingVertical: 24,
    alignItems: "center",
    gap: 8,
  },
  scanningText: {
    fontSize: 14,
    color: colors.textSecondary,
  },

  // ── Form (after selection) ──
  label: {
    fontSize: 14,
    fontWeight: "600",
    color: colors.textSecondary,
    marginBottom: 4,
    marginTop: 14,
  },
  input: {
    backgroundColor: colors.surface,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.surfaceSecondary,
    padding: 12,
    fontSize: 16,
    color: colors.text,
  },
  calorieInput: {
    fontSize: 24,
    fontWeight: "700",
    textAlign: "center",
    paddingVertical: 16,
  },
  servingHint: {
    fontSize: 13,
    color: colors.textTertiary,
    marginTop: 4,
    textAlign: "center",
  },
  mealSelector: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginTop: 4,
  },
  mealChip: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 18,
    backgroundColor: colors.surfaceSecondary,
  },
  mealChipSelected: {
    backgroundColor: colors.accent,
  },
  mealChipText: {
    fontSize: 14,
    color: colors.textSecondary,
    fontWeight: "500",
  },
  mealChipTextSelected: {
    color: colors.text,
  },
  macroRow: {
    flexDirection: "row",
    gap: 10,
    marginTop: 16,
  },
  macroField: {
    flex: 1,
    alignItems: "center",
    gap: 4,
  },
  macroLabel: {
    fontSize: 12,
    fontWeight: "600",
    color: colors.textSecondary,
  },
  macroInput: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: 8,
    padding: 10,
    fontSize: 16,
    color: colors.text,
    textAlign: "center",
    width: "100%",
  },
  macroLabelRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  macroDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  formButtons: {
    flexDirection: "row",
    gap: 12,
    marginTop: 28,
  },
  backButton: {
    flex: 1,
    borderRadius: 12,
    padding: 16,
    alignItems: "center",
    borderWidth: 1,
    borderColor: colors.surfaceSecondary,
  },
  backButtonText: {
    color: colors.textSecondary,
    fontSize: 16,
    fontWeight: "600",
  },
  saveButton: {
    backgroundColor: colors.accent,
    borderRadius: 12,
    padding: 16,
    alignItems: "center",
  },
  saveButtonDisabled: {
    opacity: 0.5,
  },
  saveButtonText: {
    color: colors.text,
    fontSize: 17,
    fontWeight: "700",
  },

  // ── Quick-add tab ──
  quickAddNameInput: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 16,
    color: colors.text,
    marginBottom: 12,
  },
  quickAddCalorieSection: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "center",
    gap: 4,
    marginTop: 16,
    marginBottom: 8,
  },
  quickAddCalorieInput: {
    fontSize: 48,
    fontWeight: "700",
    color: colors.text,
    textAlign: "center",
    minWidth: 120,
    fontVariant: ["tabular-nums"],
  },
  quickAddCalorieUnit: {
    fontSize: 20,
    color: colors.textSecondary,
    fontWeight: "500",
  },
});
