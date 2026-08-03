import { providerDangerZoneCopy } from "@dofek/providers/provider-disconnect";
import { statusColors } from "@dofek/scoring/colors";
import { type ComponentRef, useCallback, useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  Alert,
  findNodeHandle,
  Modal,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import {
  OperationProgressBars,
  type OperationProgressItem,
} from "../../components/OperationProgressBar";
import { captureException } from "../../lib/telemetry";
import { trpc } from "../../lib/trpc";
import { colors } from "../../theme";

export function ProviderDangerZone({
  additionalOperations = [],
  canDisconnect,
  providerId,
  providerName,
}: {
  additionalOperations?: readonly OperationProgressItem[];
  canDisconnect: boolean;
  providerId: string;
  providerName: string;
}) {
  const trpcUtils = trpc.useUtils();
  const disconnectMutation = trpc.providerDetail.disconnect.useMutation();
  const deleteAllDataMutation = trpc.providerDetail.deleteAllData.useMutation();
  const copy = providerDangerZoneCopy(providerName);
  const [showDisconnectConfirm, setShowDisconnectConfirm] = useState(false);
  const [disconnectPending, setDisconnectPending] = useState(false);
  const [disconnectError, setDisconnectError] = useState<string | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [operationId, setOperationId] = useState<string | null>(null);
  const completionStarted = useRef(false);
  const disconnectInFlight = useRef(false);
  const disconnectCancelRef = useRef<ComponentRef<typeof TouchableOpacity>>(null);
  const deletionStatus = trpc.providerDetail.deletionStatus.useQuery(
    { providerId, operationId: operationId ?? "00000000-0000-0000-0000-000000000000" },
    {
      enabled: operationId !== null,
      refetchInterval: operationId === null ? false : 1000,
      staleTime: 0,
    },
  );

  const closeConfirm = useCallback(() => {
    setConfirmation("");
    setShowConfirm(false);
  }, []);

  const closeDisconnectConfirm = useCallback(() => {
    if (disconnectInFlight.current) return;
    setDisconnectError(null);
    setShowDisconnectConfirm(false);
  }, []);

  const focusDisconnectCancel = useCallback(() => {
    const node = findNodeHandle(disconnectCancelRef.current);
    if (node !== null) AccessibilityInfo.setAccessibilityFocus(node);
  }, []);

  const disconnectProvider = useCallback(async () => {
    if (disconnectInFlight.current) return;
    disconnectInFlight.current = true;
    setDisconnectPending(true);
    setDisconnectError(null);
    try {
      await disconnectMutation.mutateAsync({ providerId });
      await Promise.all([
        trpcUtils.sync.providers.invalidate(),
        trpcUtils.sync.providerStats.invalidate(),
        trpcUtils.processing.status.invalidate(),
      ]);
      setShowDisconnectConfirm(false);
    } catch (error: unknown) {
      captureException(error, { context: "provider-disconnect" });
      setDisconnectError(error instanceof Error ? error.message : "Unable to disconnect provider.");
    } finally {
      disconnectInFlight.current = false;
      setDisconnectPending(false);
    }
  }, [disconnectMutation, providerId, trpcUtils]);

  const finishDeletion = useCallback(async () => {
    await Promise.all([
      trpcUtils.sync.providers.invalidate(),
      trpcUtils.sync.providerStats.invalidate(),
      trpcUtils.processing.status.invalidate(),
      trpcUtils.providerDetail.records.invalidate({ providerId }),
      trpcUtils.providerDetail.logs.invalidate({ providerId }),
    ]);
    setOperationId(null);
    closeConfirm();
    Alert.alert("Data Deleted", "Provider data deletion completed.");
  }, [closeConfirm, providerId, trpcUtils]);

  useEffect(() => {
    if (!operationId) return;
    if (deletionStatus.data?.status === "completed") {
      if (completionStarted.current) return;
      completionStarted.current = true;
      void finishDeletion().catch((error: unknown) => {
        captureException(error, { context: "provider-delete-finish" });
        Alert.alert(
          "Refresh Failed",
          error instanceof Error ? error.message : "Failed to refresh provider data",
        );
        setOperationId(null);
      });
      return;
    }
    if (deletionStatus.data?.status === "failed") {
      Alert.alert("Delete Failed", deletionStatus.data.message ?? "Provider data deletion failed");
      setOperationId(null);
      return;
    }
    if (deletionStatus.error) {
      captureException(deletionStatus.error, { context: "provider-delete-status" });
      Alert.alert("Delete Failed", deletionStatus.error.message);
      setOperationId(null);
    }
  }, [deletionStatus.data, deletionStatus.error, finishDeletion, operationId]);

  const deleteAllData = async () => {
    if (confirmation !== "DELETE") return;
    try {
      const result = await deleteAllDataMutation.mutateAsync({
        providerId,
        confirmation: "DELETE",
      });
      completionStarted.current = false;
      setOperationId(result.operationId);
    } catch (error: unknown) {
      captureException(error, { context: "provider-delete-all-data" });
      Alert.alert(
        "Delete Failed",
        error instanceof Error ? error.message : "Failed to delete provider data",
      );
    }
  };

  const progressOperations: readonly OperationProgressItem[] = operationId
    ? [
        ...additionalOperations,
        {
          id: `provider-data-deletion-${operationId}`,
          label: "Provider data deletion",
          percentage: deletionStatus.data?.percentage,
          message: deletionStatus.data?.message ?? "Preparing provider data deletion...",
        },
      ]
    : additionalOperations;

  return (
    <View style={styles.dangerZone}>
      <Text accessibilityRole="header" style={styles.dangerZoneTitle}>
        Danger Zone
      </Text>
      {canDisconnect ? (
        <View style={styles.dangerZoneAction}>
          <Text style={styles.description}>{copy.disconnectDescription}</Text>
          <TouchableOpacity
            style={styles.dangerButton}
            onPress={() => {
              setDisconnectError(null);
              setShowDisconnectConfirm(true);
            }}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel={copy.disconnectActionLabel}
          >
            <Text style={styles.deleteAllDataButtonText}>{copy.disconnectActionLabel}</Text>
          </TouchableOpacity>
        </View>
      ) : null}
      <View style={styles.dangerZoneAction}>
        <Text style={styles.description}>{copy.deleteDescription}</Text>
        <TouchableOpacity
          style={styles.dangerButton}
          onPress={() => setShowConfirm(true)}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="Delete All Data"
        >
          <Text style={styles.deleteAllDataButtonText}>Delete All Data</Text>
        </TouchableOpacity>
      </View>

      <Modal
        visible={showDisconnectConfirm}
        transparent
        animationType="fade"
        onShow={focusDisconnectCancel}
        onRequestClose={closeDisconnectConfirm}
      >
        <View style={styles.backdrop}>
          <View style={styles.card}>
            <Text accessibilityRole="header" style={styles.title}>
              {copy.disconnectTitle}
            </Text>
            <Text style={styles.description}>{copy.disconnectDescription}</Text>
            {disconnectError ? (
              <Text accessibilityRole="alert" style={styles.errorText}>
                {disconnectError}
              </Text>
            ) : null}
            <View style={styles.actions}>
              <TouchableOpacity
                ref={disconnectCancelRef}
                onPress={closeDisconnectConfirm}
                disabled={disconnectPending}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel="Cancel disconnect"
                accessibilityState={{ disabled: disconnectPending }}
              >
                <Text style={styles.cancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => void disconnectProvider()}
                disabled={disconnectPending}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel={`Confirm disconnect ${providerName}`}
                accessibilityState={{ busy: disconnectPending, disabled: disconnectPending }}
                style={[styles.confirmButton, disconnectPending && styles.confirmButtonDisabled]}
              >
                <Text style={styles.confirmText}>
                  {disconnectPending ? copy.disconnectPendingLabel : copy.disconnectActionLabel}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={showConfirm} transparent animationType="fade" onRequestClose={closeConfirm}>
        <View style={styles.backdrop}>
          <View style={styles.card}>
            <Text style={styles.title}>
              {operationId ? "Deleting Provider Data..." : "Delete All Provider Data?"}
            </Text>
            {operationId ? (
              <OperationProgressBars operations={progressOperations} />
            ) : (
              <>
                <Text style={styles.description}>
                  This permanently deletes metric stream samples, activities, daily metrics, sleep,
                  nutrition, clinical records, and derived analytics. This does not change the
                  provider&apos;s connection state.
                </Text>
                <Text style={styles.label}>Type DELETE to confirm</Text>
                <TextInput
                  value={confirmation}
                  onChangeText={setConfirmation}
                  placeholder="DELETE"
                  placeholderTextColor={colors.textTertiary}
                  autoCapitalize="characters"
                  autoCorrect={false}
                  style={styles.input}
                />
                <View style={styles.actions}>
                  <TouchableOpacity
                    onPress={closeConfirm}
                    disabled={deleteAllDataMutation.isPending}
                    activeOpacity={0.7}
                    accessibilityRole="button"
                    accessibilityLabel="Cancel provider data deletion"
                    accessibilityState={{ disabled: deleteAllDataMutation.isPending }}
                  >
                    <Text style={styles.cancelText}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => void deleteAllData()}
                    disabled={confirmation !== "DELETE" || deleteAllDataMutation.isPending}
                    accessibilityState={{
                      busy: deleteAllDataMutation.isPending,
                      disabled: confirmation !== "DELETE" || deleteAllDataMutation.isPending,
                    }}
                    accessibilityRole="button"
                    accessibilityLabel="Permanently Delete Data"
                    activeOpacity={0.7}
                    style={[
                      styles.confirmButton,
                      (confirmation !== "DELETE" || deleteAllDataMutation.isPending) &&
                        styles.confirmButtonDisabled,
                    ]}
                  >
                    <Text style={styles.confirmText}>
                      {deleteAllDataMutation.isPending ? "Deleting..." : "Permanently Delete Data"}
                    </Text>
                  </TouchableOpacity>
                </View>
              </>
            )}
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  dangerZone: {
    borderWidth: 1,
    borderColor: "rgba(239, 68, 68, 0.35)",
    borderRadius: 12,
    padding: 16,
    marginTop: 24,
    gap: 16,
  },
  dangerZoneTitle: {
    color: statusColors.danger,
    fontSize: 14,
    fontWeight: "600",
  },
  dangerZoneAction: {
    gap: 10,
  },
  dangerButton: {
    borderWidth: 1,
    borderColor: statusColors.danger,
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: "center",
  },
  deleteAllDataButtonText: {
    color: statusColors.danger,
    fontSize: 14,
    fontWeight: "600",
  },
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.7)",
    justifyContent: "center",
    padding: 24,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: 14,
    padding: 20,
  },
  title: {
    color: statusColors.danger,
    fontSize: 18,
    fontWeight: "700",
  },
  description: {
    color: colors.textSecondary,
    fontSize: 13,
    lineHeight: 19,
  },
  errorText: {
    color: statusColors.danger,
    fontSize: 13,
    lineHeight: 19,
    marginTop: 10,
  },
  label: {
    color: colors.textSecondary,
    fontSize: 12,
    marginTop: 18,
    marginBottom: 6,
  },
  input: {
    borderWidth: 1,
    borderColor: colors.surfaceSecondary,
    borderRadius: 8,
    color: colors.text,
    fontSize: 15,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  actions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    alignItems: "center",
    gap: 16,
    marginTop: 20,
  },
  cancelText: {
    color: colors.textSecondary,
    fontSize: 14,
  },
  confirmButton: {
    backgroundColor: statusColors.danger,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  confirmButtonDisabled: {
    opacity: 0.4,
  },
  confirmText: {
    color: colors.textInverse,
    fontSize: 13,
    fontWeight: "600",
  },
});
