import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { OperationProgressBar } from "../../components/OperationProgressBar";
import { colors } from "../../theme";

export function ProviderDetailActionsCard({
  primaryActionLabel,
  isSyncing,
  syncMessage,
  syncProgress,
  shouldShowFullSync,
  shouldShowAppleHealthPermissionBanner,
  onPrimaryAction,
  onFullSync,
}: {
  primaryActionLabel: "Sync" | "Connect" | "Reconnect";
  isSyncing: boolean;
  syncMessage: string | null;
  syncProgress: number | null;
  shouldShowFullSync: boolean;
  shouldShowAppleHealthPermissionBanner: boolean;
  onPrimaryAction: () => void;
  onFullSync: () => void;
}) {
  return (
    <View style={styles.actionCard}>
      <Text style={styles.actionTitle}>Actions</Text>
      <View style={styles.syncButtonRow}>
        <TouchableOpacity
          style={[styles.syncButton, isSyncing && styles.syncButtonDisabled]}
          onPress={onPrimaryAction}
          activeOpacity={0.7}
          disabled={isSyncing}
        >
          <Text style={styles.syncButtonText}>{primaryActionLabel}</Text>
        </TouchableOpacity>
        {shouldShowFullSync && (
          <TouchableOpacity
            style={[styles.secondaryButton, isSyncing && styles.syncButtonDisabled]}
            onPress={onFullSync}
            activeOpacity={0.7}
            disabled={isSyncing}
          >
            <Text style={styles.secondaryButtonText}>Full sync</Text>
          </TouchableOpacity>
        )}
      </View>
      {isSyncing && (
        <OperationProgressBar
          percentage={syncProgress ?? undefined}
          message={syncMessage ?? undefined}
        />
      )}
      {!isSyncing && syncMessage != null && (
        <Text style={styles.syncMessageText}>{syncMessage}</Text>
      )}
      {shouldShowAppleHealthPermissionBanner && (
        <TouchableOpacity onPress={onPrimaryAction} activeOpacity={0.7}>
          <Text style={styles.permissionBannerText}>
            Apple Health permissions need updating — tap to review
          </Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  actionCard: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: 16,
    gap: 12,
  },
  actionTitle: {
    fontSize: 14,
    fontWeight: "700",
    color: colors.text,
  },
  syncButtonRow: {
    flexDirection: "row",
    gap: 8,
  },
  syncButton: {
    flex: 1,
    backgroundColor: colors.accent,
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: "center",
  },
  syncButtonDisabled: {
    opacity: 0.5,
  },
  syncButtonText: {
    fontSize: 14,
    fontWeight: "600",
    color: colors.text,
  },
  secondaryButton: {
    flex: 1,
    backgroundColor: colors.surfaceSecondary,
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: "center",
  },
  secondaryButtonText: {
    fontSize: 14,
    fontWeight: "600",
    color: colors.text,
  },
  syncMessageText: {
    fontSize: 12,
    color: colors.textSecondary,
  },
  permissionBannerText: {
    fontSize: 12,
    color: colors.warning,
  },
});
