import { formatDateYmd } from "@dofek/format/format";
import DateTimePicker from "@react-native-community/datetimepicker";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { OperationProgressBar } from "../../components/OperationProgressBar";
import { colors } from "../../theme";
import type { ProviderSyncDateRange } from "./use-provider-detail-actions";

function localDateFromYmd(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year ?? 0, (month ?? 1) - 1, day ?? 1, 12);
}

export function ProviderDetailActionsCard({
  primaryActionLabel,
  isSyncing,
  isRequestingPermissions,
  permissionMessage,
  syncMessage,
  syncProgress,
  syncDateRange,
  shouldShowFullSync,
  shouldShowAppleHealthPermissionBanner,
  onPrimaryAction,
  onReviewPermissions,
  onFullSync,
}: {
  primaryActionLabel: "Sync" | "Connect" | "Reconnect" | "Resume";
  isSyncing: boolean;
  isRequestingPermissions: boolean;
  permissionMessage: string | null;
  syncMessage: string | null;
  syncProgress: number | null;
  syncDateRange: ProviderSyncDateRange | null;
  shouldShowFullSync: boolean;
  shouldShowAppleHealthPermissionBanner: boolean;
  onPrimaryAction: () => void;
  onReviewPermissions: () => void;
  onFullSync: () => void;
}) {
  const isBusy = isSyncing || isRequestingPermissions;
  return (
    <View style={styles.actionCard}>
      <Text style={styles.actionTitle}>Actions</Text>
      {syncDateRange ? (
        <View style={styles.dateRange}>
          <View style={styles.dateField}>
            <Text style={styles.dateLabel}>From</Text>
            <DateTimePicker
              accessibilityLabel="From"
              disabled={isBusy}
              display="compact"
              maximumDate={localDateFromYmd(syncDateRange.untilDate)}
              mode="date"
              onChange={(_event, selectedDate) => {
                if (selectedDate) {
                  syncDateRange.onSinceDateChange(formatDateYmd(selectedDate));
                }
              }}
              value={localDateFromYmd(syncDateRange.sinceDate)}
            />
          </View>
          <View style={styles.dateField}>
            <Text style={styles.dateLabel}>To</Text>
            <DateTimePicker
              accessibilityLabel="To"
              disabled={isBusy}
              display="compact"
              maximumDate={localDateFromYmd(formatDateYmd())}
              minimumDate={localDateFromYmd(syncDateRange.sinceDate)}
              mode="date"
              onChange={(_event, selectedDate) => {
                if (selectedDate) {
                  syncDateRange.onUntilDateChange(formatDateYmd(selectedDate));
                }
              }}
              value={localDateFromYmd(syncDateRange.untilDate)}
            />
          </View>
        </View>
      ) : null}
      <View style={styles.syncButtonRow}>
        <TouchableOpacity
          style={[styles.syncButton, isBusy && styles.syncButtonDisabled]}
          onPress={onPrimaryAction}
          activeOpacity={0.7}
          disabled={isBusy}
          accessibilityRole="button"
          accessibilityLabel={primaryActionLabel}
          accessibilityState={{ busy: isBusy, disabled: isBusy }}
        >
          <Text style={styles.syncButtonText}>{primaryActionLabel}</Text>
        </TouchableOpacity>
        {shouldShowFullSync && (
          <TouchableOpacity
            style={[styles.secondaryButton, isBusy && styles.syncButtonDisabled]}
            onPress={onFullSync}
            activeOpacity={0.7}
            disabled={isBusy}
            accessibilityRole="button"
            accessibilityLabel="Full sync"
            accessibilityState={{ busy: isBusy, disabled: isBusy }}
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
        <TouchableOpacity
          onPress={onReviewPermissions}
          disabled={isRequestingPermissions}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="Review Apple Health permissions"
          accessibilityState={{ busy: isRequestingPermissions, disabled: isRequestingPermissions }}
        >
          <Text style={styles.permissionBannerText}>
            Apple Health permissions need updating — tap to review
          </Text>
        </TouchableOpacity>
      )}
      {permissionMessage ? <Text style={styles.syncMessageText}>{permissionMessage}</Text> : null}
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
  dateRange: {
    flexDirection: "row",
    gap: 12,
  },
  dateField: {
    flex: 1,
    gap: 4,
  },
  dateLabel: {
    fontSize: 12,
    color: colors.textSecondary,
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
