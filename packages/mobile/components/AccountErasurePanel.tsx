import { accountErasureCleanupWasBlocked } from "@dofek/auth/account-erasure";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import {
  clearMobileAccountErasurePreparation,
  loadMobileAccountErasurePreparation,
  markMobileAccountErasureConfirmationAttempted,
  saveMobileAccountErasurePreparation,
  saveMobileAccountErasureStatusCapability,
} from "../lib/account-erasure-storage";
import { type AccountErasureCleanupLease, useAuth } from "../lib/auth-context";
import { purgeMobileAccountState } from "../lib/mobile-account-purge";
import { captureException } from "../lib/telemetry";
import { trpc } from "../lib/trpc";
import { colors } from "../theme";

export function AccountErasurePanel() {
  const auth = useAuth();
  const router = useRouter();
  const queryClient = useQueryClient();
  const userId = auth.user?.id;
  const [expanded, setExpanded] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [preparation, setPreparation] =
    useState<Awaited<ReturnType<typeof loadMobileAccountErasurePreparation>>>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const prepareMutation = trpc.accountErasure.prepare.useMutation();
  const confirmMutation = trpc.accountErasure.confirm.useMutation();

  useEffect(() => {
    if (!userId) return;
    void loadMobileAccountErasurePreparation(userId)
      .then((saved) => {
        if (saved && new Date(saved.expiresAt).getTime() > Date.now()) {
          setPreparation(saved);
          setExpanded(true);
        }
      })
      .catch((error: unknown) => {
        captureException(error, { source: "account-erasure-mobile-preparation-restore" });
      });
  }, [userId]);

  async function prepareDeletion(): Promise<void> {
    if (!userId || confirmation !== "DELETE") return;
    setLocalError(null);
    try {
      const prepared = await prepareMutation.mutateAsync({ confirmation: "DELETE" });
      const capability = { ...prepared, ownerUserId: userId };
      await saveMobileAccountErasurePreparation(capability);
      setPreparation(capability);
    } catch (error: unknown) {
      captureException(error, { source: "account-erasure-mobile-prepare" });
      setLocalError(error instanceof Error ? error.message : String(error));
    }
  }

  async function confirmDeletion(): Promise<void> {
    if (!preparation) return;
    setLocalError(null);
    let accepted = false;
    let confirmationAttempted = false;
    let cleanupLease: AccountErasureCleanupLease | null = null;
    try {
      cleanupLease = auth.beginAccountErasureCleanup(preparation.ownerUserId);
      const attempted = await markMobileAccountErasureConfirmationAttempted(
        cleanupLease.cleanupOwnerNonce,
      );
      confirmationAttempted = true;
      const initiated = await confirmMutation.mutateAsync({
        preparationToken: attempted.preparationToken,
      });
      accepted = true;
      const statusCapability = {
        cleanupOwnerNonce: attempted.cleanupOwnerNonce,
        requestId: initiated.requestId,
        statusToken: initiated.statusToken,
      };
      await saveMobileAccountErasureStatusCapability(statusCapability);
      await clearMobileAccountErasurePreparation();
      const purgeResult = await purgeMobileAccountState({
        cleanupLease,
        isCleanupLeaseCurrent: auth.isAccountErasureCleanupLeaseCurrent,
        queryClient,
      });
      if (purgeResult.errors.length > 0) {
        await saveMobileAccountErasureStatusCapability({
          ...statusCapability,
          localCleanupBlockedByAnotherSession:
            accountErasureCleanupWasBlocked(purgeResult.errors) || undefined,
          localCleanupPending: true,
        });
      }
      router.replace("/account-deletion");
    } catch (error: unknown) {
      captureException(
        accepted
          ? new Error("Post-confirm account erasure cleanup failed.")
          : new Error("Account erasure confirmation failed."),
        { source: "account-erasure-mobile-confirm" },
      );
      setLocalError(
        accepted
          ? "Account deletion was accepted and your session was closed. Check the account deletion status page for updates."
          : confirmationAttempted
            ? `${error instanceof Error ? error.message : String(error)} We could not confirm the outcome. Check the account deletion status page for updates.`
            : `${error instanceof Error ? error.message : String(error)} Account deletion was not started. Sign in and try again from Settings.`,
      );
      if (accepted || confirmationAttempted) {
        router.replace("/account-deletion");
      }
    } finally {
      if (cleanupLease) {
        auth.finishAccountErasureCleanup(cleanupLease);
      }
    }
  }

  const isPending = prepareMutation.isPending || confirmMutation.isPending;

  if (!expanded && !preparation) {
    return (
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel="Delete account"
        onPress={() => setExpanded(true)}
        style={styles.openButton}
      >
        <Text style={styles.openButtonText}>Delete account</Text>
      </TouchableOpacity>
    );
  }

  return (
    <View style={styles.content}>
      <Text style={styles.disclosure}>
        This permanently closes your Dofek account, disconnects providers, and starts deletion of
        Dofek-held account and health data. It cannot be undone.
      </Text>
      <Text style={styles.disclosure}>
        HealthKit and Core Motion source records remain controlled by iOS. Dofek removes nutrition
        samples it wrote, but cannot delete operating-system-owned source history. Payment
        processors may retain transaction records when legally required.
      </Text>

      {preparation ? (
        <View style={styles.finalCard}>
          <Text style={styles.finalText}>
            Final confirmation: deletion starts immediately, your session ends, and new writes are
            blocked.
          </Text>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel="Permanently delete my account"
            disabled={isPending}
            onPress={() => void confirmDeletion()}
            style={[styles.dangerButton, isPending && styles.disabled]}
          >
            <Text style={styles.dangerButtonText}>
              {confirmMutation.isPending
                ? "Starting account deletion..."
                : "Permanently delete my account"}
            </Text>
          </TouchableOpacity>
        </View>
      ) : (
        <View style={styles.form}>
          <TextInput
            accessibilityLabel={'Type "DELETE" to continue'}
            autoCapitalize="characters"
            autoCorrect={false}
            onChangeText={setConfirmation}
            placeholder='Type "DELETE"'
            placeholderTextColor={colors.textTertiary}
            style={styles.input}
            value={confirmation}
          />
          <View style={styles.actions}>
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel="Prepare account deletion"
              disabled={confirmation !== "DELETE" || isPending}
              onPress={() => void prepareDeletion()}
              style={[
                styles.prepareButton,
                (confirmation !== "DELETE" || isPending) && styles.disabled,
              ]}
            >
              <Text style={styles.prepareText}>
                {prepareMutation.isPending ? "Preparing..." : "Prepare account deletion"}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel="Cancel account deletion"
              disabled={isPending}
              onPress={() => {
                setExpanded(false);
                setConfirmation("");
                setLocalError(null);
              }}
              style={styles.cancelButton}
            >
              <Text style={styles.cancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {localError ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {localError}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  cancelButton: { paddingHorizontal: 14, paddingVertical: 12 },
  cancelText: { color: colors.textSecondary, fontSize: 14 },
  content: { gap: 12 },
  dangerButton: {
    alignItems: "center",
    backgroundColor: colors.danger,
    borderRadius: 10,
    padding: 13,
  },
  dangerButtonText: { color: colors.text, fontSize: 14, fontWeight: "700" },
  disabled: { opacity: 0.45 },
  disclosure: { color: colors.textSecondary, fontSize: 13, lineHeight: 19 },
  error: { color: colors.danger, fontSize: 13, lineHeight: 19 },
  finalCard: { backgroundColor: colors.surfaceSecondary, borderRadius: 12, gap: 12, padding: 12 },
  finalText: { color: colors.danger, fontSize: 13, lineHeight: 19 },
  form: { gap: 12 },
  input: {
    backgroundColor: colors.surfaceSecondary,
    borderColor: colors.danger,
    borderRadius: 10,
    borderWidth: 1,
    color: colors.text,
    fontSize: 15,
    paddingHorizontal: 13,
    paddingVertical: 12,
  },
  openButton: {
    alignItems: "center",
    borderColor: colors.danger,
    borderRadius: 12,
    borderWidth: 1.5,
    paddingVertical: 12,
  },
  openButtonText: { color: colors.danger, fontSize: 14, fontWeight: "600" },
  prepareButton: {
    borderColor: colors.danger,
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  prepareText: { color: colors.danger, fontSize: 14, fontWeight: "600" },
});
