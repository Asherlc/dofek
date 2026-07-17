import { statusColors } from "@dofek/scoring/colors";
import { useState } from "react";
import { Alert, Modal, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { captureException } from "../../lib/telemetry";
import { trpc } from "../../lib/trpc";
import { colors } from "../../theme";

export function ProviderDataDeleteControl({ providerId }: { providerId: string }) {
  const trpcUtils = trpc.useUtils();
  const deleteAllDataMutation = trpc.providerDetail.deleteAllData.useMutation();
  const [showConfirm, setShowConfirm] = useState(false);
  const [confirmation, setConfirmation] = useState("");

  const closeConfirm = () => {
    setConfirmation("");
    setShowConfirm(false);
  };

  const deleteAllData = async () => {
    if (confirmation !== "DELETE") return;
    try {
      await deleteAllDataMutation.mutateAsync({ providerId, confirmation: "DELETE" });
      await Promise.all([
        trpcUtils.sync.providers.invalidate(),
        trpcUtils.sync.providerStats.invalidate(),
        trpcUtils.sync.dataHealth.invalidate(),
        trpcUtils.providerDetail.records.invalidate({ providerId }),
        trpcUtils.providerDetail.logs.invalidate({ providerId }),
      ]);
      closeConfirm();
      Alert.alert(
        "Data Deleted",
        "Provider records were deleted. ClickHouse analytics are reprocessing.",
      );
    } catch (error: unknown) {
      captureException(error, { context: "provider-delete-all-data" });
      Alert.alert(
        "Delete Failed",
        error instanceof Error ? error.message : "Failed to delete provider data",
      );
    }
  };

  return (
    <>
      <TouchableOpacity
        style={styles.deleteAllDataButton}
        onPress={() => setShowConfirm(true)}
        activeOpacity={0.7}
      >
        <Text style={styles.deleteAllDataButtonText}>Delete All Data</Text>
      </TouchableOpacity>
      <Modal visible={showConfirm} transparent animationType="fade" onRequestClose={closeConfirm}>
        <View style={styles.backdrop}>
          <View style={styles.card}>
            <Text style={styles.title}>Delete All Provider Data?</Text>
            <Text style={styles.description}>
              This permanently deletes metric stream samples, activities, daily metrics, sleep,
              nutrition, clinical records, and derived analytics. The provider stays connected.
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
              >
                <Text style={styles.cancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => void deleteAllData()}
                disabled={confirmation !== "DELETE" || deleteAllDataMutation.isPending}
                accessibilityState={{
                  disabled: confirmation !== "DELETE" || deleteAllDataMutation.isPending,
                }}
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
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  deleteAllDataButton: {
    borderWidth: 1,
    borderColor: statusColors.danger,
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: "center",
    marginTop: 24,
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
    color: colors.background,
    fontSize: 13,
    fontWeight: "600",
  },
});
