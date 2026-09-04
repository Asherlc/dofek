import { SYNC_ALL_ACTIONS } from "@dofek/providers/sync-actions";
import { type ComponentRef, useCallback, useRef, useState } from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
  Modal,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { colors } from "../../theme";

export interface SyncAllControlsProps {
  busy: boolean;
  errorMessage?: string;
  onFullSync: () => void;
  onRecentSync: () => void;
}

export function SyncAllControls({
  busy,
  errorMessage,
  onFullSync,
  onRecentSync,
}: SyncAllControlsProps) {
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const cancelRef = useRef<ComponentRef<typeof TouchableOpacity>>(null);
  const closeConfirmation = useCallback(() => setConfirmationOpen(false), []);
  const focusCancel = useCallback(() => {
    if (cancelRef.current) {
      AccessibilityInfo.sendAccessibilityEvent(cancelRef.current, "focus");
    }
  }, []);

  return (
    <View style={styles.container}>
      <TouchableOpacity
        style={[styles.recentButton, busy && styles.disabled]}
        onPress={onRecentSync}
        disabled={busy}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel={SYNC_ALL_ACTIONS.recent.accessibilityLabel}
        accessibilityState={{ busy, disabled: busy }}
      >
        {busy ? (
          <ActivityIndicator color={colors.textInverse} size="small" />
        ) : (
          <Text style={styles.recentButtonText}>{SYNC_ALL_ACTIONS.recent.label}</Text>
        )}
      </TouchableOpacity>
      <Text style={styles.description}>{SYNC_ALL_ACTIONS.recent.description}</Text>
      <TouchableOpacity
        style={[styles.fullButton, busy && styles.disabled]}
        onPress={() => setConfirmationOpen(true)}
        disabled={busy}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel={SYNC_ALL_ACTIONS.full.accessibilityLabel}
        accessibilityState={{ disabled: busy }}
      >
        <Text style={styles.fullButtonText}>{SYNC_ALL_ACTIONS.full.label}</Text>
      </TouchableOpacity>

      {busy ? (
        <Text style={styles.progress} accessibilityLiveRegion="polite">
          {SYNC_ALL_ACTIONS.progressMessage}
        </Text>
      ) : null}
      {errorMessage ? (
        <Text style={styles.error} accessibilityRole="alert">
          {errorMessage}
        </Text>
      ) : null}

      <Modal
        visible={confirmationOpen}
        transparent
        animationType="fade"
        onRequestClose={closeConfirmation}
        onShow={focusCancel}
      >
        <View style={styles.backdrop}>
          <View style={styles.dialog} accessibilityViewIsModal>
            <Text style={styles.title} accessibilityRole="header">
              {SYNC_ALL_ACTIONS.full.confirmationTitle}
            </Text>
            <Text style={styles.confirmationDescription}>
              {SYNC_ALL_ACTIONS.full.confirmationDescription}
            </Text>
            <View style={styles.actions}>
              <TouchableOpacity
                ref={cancelRef}
                accessible
                onPress={closeConfirmation}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel={SYNC_ALL_ACTIONS.full.cancelLabel}
                accessibilityHint="Closes without starting a full sync"
              >
                <Text style={styles.cancelText}>{SYNC_ALL_ACTIONS.full.cancelLabel}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.confirmButton}
                onPress={() => {
                  closeConfirmation();
                  onFullSync();
                }}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel={SYNC_ALL_ACTIONS.full.confirmLabel}
              >
                <Text style={styles.confirmButtonText}>{SYNC_ALL_ACTIONS.full.confirmLabel}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: "stretch",
    marginBottom: 20,
  },
  recentButton: {
    alignItems: "center",
    backgroundColor: colors.accent,
    borderRadius: 12,
    paddingVertical: 14,
  },
  recentButtonText: {
    color: colors.textInverse,
    fontSize: 16,
    fontWeight: "600",
  },
  disabled: {
    opacity: 0.5,
  },
  description: {
    color: colors.textSecondary,
    fontSize: 12,
    marginTop: 6,
    textAlign: "center",
  },
  fullButton: {
    alignSelf: "center",
    marginTop: 10,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  fullButtonText: {
    color: colors.accent,
    fontSize: 13,
    fontWeight: "600",
  },
  progress: {
    color: colors.textSecondary,
    fontSize: 12,
    marginTop: 8,
    textAlign: "center",
  },
  error: {
    color: colors.danger,
    fontSize: 12,
    marginTop: 8,
    textAlign: "center",
  },
  backdrop: {
    backgroundColor: "rgba(0, 0, 0, 0.7)",
    flex: 1,
    justifyContent: "center",
    padding: 24,
  },
  dialog: {
    backgroundColor: colors.surface,
    borderRadius: 14,
    padding: 20,
  },
  title: {
    color: colors.text,
    fontSize: 18,
    fontWeight: "700",
  },
  confirmationDescription: {
    color: colors.textSecondary,
    fontSize: 13,
    lineHeight: 19,
    marginTop: 10,
  },
  actions: {
    alignItems: "center",
    flexDirection: "row",
    gap: 16,
    justifyContent: "flex-end",
    marginTop: 20,
  },
  cancelText: {
    color: colors.textSecondary,
    fontSize: 14,
  },
  confirmButton: {
    backgroundColor: colors.accent,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  confirmButtonText: {
    color: colors.textInverse,
    fontSize: 13,
    fontWeight: "600",
  },
});
