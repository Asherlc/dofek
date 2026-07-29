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
  syncMessage,
  syncProgress,
  syncDateRange,
  shouldShowFullSync,
  shouldShowAppleHealthPermissionBanner,
  onPrimaryAction,
  onFullSync,
}: {
  primaryActionLabel: "Sync" | "Connect" | "Reconnect";
  isSyncing: boolean;
  syncMessage: string | null;
  syncProgress: number | null;
  syncDateRange: ProviderSyncDateRange | null;
  shouldShowFullSync: boolean;
  shouldShowAppleHealthPermissionBanner: boolean;
  onPrimaryAction: () => void;
  onFullSync: () => void;
}) {
  return (
    <View style={styles.actionCard}>
      <Text style={styles.actionTitle}>Actions</Text>
      {syncDateRange ? (
        <View style={styles.dateRange}>
          <View style={styles.dateField}>
            <Text style={styles.dateLabel}>From</Text>
            <DateTimePicker
              accessibilityLabel="From"
              disabled={isSyncing}
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
              disabled={isSyncing}
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
          style={[styles.syncButton, isSyncing && styles.syncButtonDisabled]}
          onPress={onPrimaryAction}
          activeOpacity={0.7}
          disabled={isSyncing}
          accessibilityRole="button"
          accessibilityLabel={primaryActionLabel}
          accessibilityState={{ busy: isSyncing, disabled: isSyncing }}
        >
          <Text style={styles.syncButtonText}>{primaryActionLabel}</Text>
        </TouchableOpacity>
        {shouldShowFullSync && (
          <TouchableOpacity
            style={[styles.secondaryButton, isSyncing && styles.syncButtonDisabled]}
            onPress={onFullSync}
            activeOpacity={0.7}
            disabled={isSyncing}
            accessibilityRole="button"
            accessibilityLabel="Full sync"
            accessibilityState={{ busy: isSyncing, disabled: isSyncing }}
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
          onPress={onPrimaryAction}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="Review Apple Health permissions"
        >
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
