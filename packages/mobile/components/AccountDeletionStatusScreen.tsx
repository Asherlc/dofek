import {
  type AccountErasureAttemptedPreparationCapability,
  type AccountErasureStatusCapability,
  accountErasureCleanupWasBlocked,
  describeAccountErasureStatus,
  type PublicAccountErasureStatus,
  PublicAccountErasureStatusSchema,
} from "@dofek/auth/account-erasure";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import {
  clearMobileAccountErasurePreparation,
  clearMobileAccountErasureStatusCapability,
  loadAnyMobileAccountErasurePreparation,
  loadMobileAccountErasureStatusCapability,
  saveMobileAccountErasureStatusCapability,
} from "../lib/account-erasure-storage";
import { type AccountErasureCleanupLease, useAuth } from "../lib/auth-context";
import { purgeMobileAccountState } from "../lib/mobile-account-purge";
import { captureException } from "../lib/telemetry";
import { trpc } from "../lib/trpc";
import { colors, radius, spacing } from "../theme";

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  dateStyle: "long",
  timeZone: "UTC",
});

const dateTimeFormatter = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
});

function formatPhase(phase: string | null): string {
  if (!phase) return "Queued";
  return phase
    .split("_")
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

export interface AccountDeletionStatusViewProps {
  capability: AccountErasureStatusCapability | null;
  error: string | null;
  isLoading: boolean;
  isRecovering?: boolean;
  localCleanupPending: boolean;
  onContact?: () => void;
  onForget?: (() => void) | undefined;
  onRecover?: (() => void) | undefined;
  onRefresh: () => void;
  onRetryLocalCleanup?: (() => void) | undefined;
  onSignIn: () => void;
  status: PublicAccountErasureStatus | null;
}

export function AccountDeletionStatusView({
  capability,
  error,
  isLoading,
  isRecovering = false,
  localCleanupPending,
  onContact,
  onForget,
  onRecover,
  onRefresh,
  onRetryLocalCleanup,
  onSignIn,
  status,
}: AccountDeletionStatusViewProps) {
  const presentation = status ? describeAccountErasureStatus(status) : null;
  const statusStyle =
    presentation?.tone === "success"
      ? styles.successCard
      : presentation?.tone === "danger"
        ? styles.dangerStatusCard
        : styles.progressCard;

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      style={styles.container}
      testID="account-deletion-status"
    >
      <Text style={styles.eyebrow}>DOFEK</Text>
      <Text accessibilityRole="header" style={styles.title}>
        Account deletion status
      </Text>
      <Text style={styles.intro}>
        This page uses a capability saved on this device. It does not require an active Dofek
        session.
      </Text>

      {isLoading && !capability && !onRecover ? (
        <View style={styles.loadingCard}>
          <ActivityIndicator color={colors.accent} size="small" />
          <Text style={styles.mutedText}>Checking for a saved deletion request...</Text>
        </View>
      ) : null}

      {onRecover && !capability ? (
        <View style={styles.recoveryCard}>
          <Text style={styles.cardTitle}>Recover an accepted request</Text>
          <Text style={styles.cardText}>
            The confirmation response may have been interrupted after your session was revoked.
            Reusing the saved preparation safely recovers the same request and status capability.
          </Text>
          <TouchableOpacity
            accessibilityLabel="Recover deletion status"
            accessibilityRole="button"
            accessibilityState={{ busy: isRecovering, disabled: isRecovering }}
            disabled={isRecovering}
            onPress={onRecover}
            style={[styles.primaryButton, isRecovering && styles.disabledButton]}
          >
            <Text style={styles.primaryButtonText}>
              {isRecovering ? "Recovering..." : "Recover deletion status"}
            </Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {error && !capability ? (
        <Text accessibilityRole="alert" style={styles.errorText}>
          {error}
        </Text>
      ) : null}

      {!isLoading && !capability && !onRecover ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>No saved request</Text>
          <Text style={styles.cardText}>
            This device does not have an account deletion status capability. Start deletion from
            Settings while signed in, or return to the device where you made the request.
          </Text>
          <TouchableOpacity
            accessibilityLabel="Sign in to request account deletion"
            accessibilityRole="button"
            onPress={onSignIn}
            style={styles.primaryButton}
          >
            <Text style={styles.primaryButtonText}>Sign in to request account deletion</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {capability ? (
        <View style={[styles.card, statusStyle]}>
          {isLoading && !status ? (
            <View style={styles.loadingRow}>
              <ActivityIndicator color={colors.accent} size="small" />
              <Text style={styles.mutedText}>Loading deletion status...</Text>
            </View>
          ) : null}

          {presentation && status ? (
            <>
              <Text style={styles.statusLabel}>{status.status.replaceAll("_", " ")}</Text>
              <Text accessibilityRole="header" style={styles.cardTitle}>
                {presentation.title}
              </Text>
              <Text style={styles.cardText}>{presentation.detail}</Text>

              <View style={styles.details}>
                <Text style={styles.detailLabel}>Request ID</Text>
                <Text style={styles.requestId}>{status.id}</Text>
                <Text style={styles.detailLabel}>Requested</Text>
                <Text style={styles.detailValue}>
                  {dateTimeFormatter.format(new Date(status.requestedAt))}
                </Text>
                <Text style={styles.detailLabel}>Active-store verification after</Text>
                <Text style={styles.detailValue}>
                  {dateFormatter.format(new Date(status.replayRetainedUntil))}
                </Text>
                <Text style={styles.detailLabel}>Current phase</Text>
                <Text style={styles.detailValue}>{formatPhase(status.currentPhase)}</Text>
                <Text style={styles.detailLabel}>Final retained-data verification by</Text>
                <Text style={styles.detailValue}>
                  {dateFormatter.format(new Date(status.retentionUntil))}
                </Text>
              </View>
            </>
          ) : null}

          {error ? (
            <Text accessibilityRole="alert" style={styles.errorText}>
              {error}
            </Text>
          ) : null}

          {localCleanupPending ? (
            <View accessibilityRole="alert" style={styles.cleanupWarning}>
              <Text style={styles.errorText}>
                {capability.localCleanupBlockedByAnotherSession
                  ? "Local cleanup belongs to the deleted account, but another account is active on this device. Sign out of that account before retrying cleanup."
                  : "Some device data could not be cleared. Unlock the device and retry local cleanup. Your deletion request and saved status capability are safe."}
              </Text>
              {onRetryLocalCleanup ? (
                <TouchableOpacity
                  accessibilityLabel="Retry local cleanup"
                  accessibilityRole="button"
                  onPress={onRetryLocalCleanup}
                  style={styles.dangerButton}
                >
                  <Text style={styles.primaryButtonText}>Retry local cleanup</Text>
                </TouchableOpacity>
              ) : null}
            </View>
          ) : null}

          <View style={styles.actions}>
            <TouchableOpacity
              accessibilityLabel="Check again"
              accessibilityRole="button"
              accessibilityState={{ busy: isLoading, disabled: isLoading }}
              disabled={isLoading}
              onPress={onRefresh}
              style={[styles.primaryButton, isLoading && styles.disabledButton]}
            >
              <Text style={styles.primaryButtonText}>
                {isLoading ? "Checking..." : "Check again"}
              </Text>
            </TouchableOpacity>
            {onForget ? (
              <TouchableOpacity
                accessibilityLabel="Forget saved status"
                accessibilityRole="button"
                onPress={onForget}
                style={styles.secondaryButton}
              >
                <Text style={styles.secondaryButtonText}>Forget saved status</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        </View>
      ) : null}

      <View style={styles.card}>
        <Text style={styles.cardTitle}>What Dofek can delete</Text>
        <Text style={styles.cardText}>
          Dofek clears its local caches and deletes nutrition samples the Dofek app wrote to
          HealthKit. HealthKit and Core Motion source records remain controlled by iOS; you can
          review or delete those records in Apple settings and the Health app.
        </Text>
        <Text style={styles.cardText}>
          Payment processors may retain legally required transaction records after Dofek
          application-data deletion finishes. Those records are not treated as active Dofek account
          data.
        </Text>
        <TouchableOpacity
          accessibilityLabel="Contact deletion support"
          accessibilityRole="button"
          onPress={onContact}
        >
          <Text style={styles.linkText}>Contact deletion support</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

export function AccountDeletionStatusScreen({
  onForget: onForgetOverride,
  onLocalCleanupComplete,
  onSignIn: onSignInOverride,
}: {
  onForget?: () => void;
  onLocalCleanupComplete?: () => void;
  onSignIn?: () => void;
} = {}) {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const router = useRouter();
  const [capability, setCapability] = useState<AccountErasureStatusCapability | null>(null);
  const [recoverablePreparation, setRecoverablePreparation] =
    useState<AccountErasureAttemptedPreparationCapability | null>(null);
  const [status, setStatus] = useState<PublicAccountErasureStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isRestoring, setIsRestoring] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [isRecovering, setIsRecovering] = useState(false);
  const { mutateAsync: requestStatus } = trpc.accountErasure.status.useMutation();
  const { mutateAsync: recoverConfirmation } = trpc.accountErasure.confirm.useMutation();

  useEffect(() => {
    let active = true;
    void Promise.all([
      loadMobileAccountErasureStatusCapability(),
      loadAnyMobileAccountErasurePreparation(),
    ])
      .then(([savedCapability, preparation]) => {
        if (!active) return;
        setCapability(savedCapability);
        setRecoverablePreparation(
          !savedCapability && preparation && "confirmationAttemptedAt" in preparation
            ? preparation
            : null,
        );
      })
      .catch((restoreError: unknown) => {
        captureException(restoreError, { source: "account-erasure-mobile-status-restore" });
        if (active) {
          setError(
            restoreError instanceof Error
              ? restoreError.message
              : "Saved deletion status could not be read.",
          );
        }
      })
      .finally(() => {
        if (active) setIsRestoring(false);
      });

    return () => {
      active = false;
    };
  }, []);

  const refresh = useCallback(
    async (target = capability): Promise<void> => {
      if (!target) return;
      setIsLoading(true);
      setError(null);
      try {
        const response = await requestStatus({ statusToken: target.statusToken });
        setStatus(PublicAccountErasureStatusSchema.parse(response));
      } catch (refreshError: unknown) {
        captureException(new Error("Public account erasure status request failed."), {
          source: "account-erasure-mobile-public-status",
        });
        setError(
          refreshError instanceof Error
            ? refreshError.message
            : "Deletion status could not be loaded.",
        );
      } finally {
        setIsLoading(false);
      }
    },
    [capability, requestStatus],
  );

  useEffect(() => {
    if (!capability) return;
    void refresh(capability);
    const interval = setInterval(() => void refresh(capability), 30_000);
    return () => clearInterval(interval);
  }, [capability, refresh]);

  async function recover(): Promise<void> {
    if (!recoverablePreparation) return;
    setIsRecovering(true);
    setError(null);
    let accepted = false;
    let cleanupLease: AccountErasureCleanupLease | null = null;
    try {
      cleanupLease = auth.beginAccountErasureCleanupForNonce(
        recoverablePreparation.cleanupOwnerNonce,
      );
      const initiated = await recoverConfirmation({
        preparationToken: recoverablePreparation.preparationToken,
      });
      accepted = true;
      const recoveredCapability = {
        cleanupOwnerNonce: recoverablePreparation.cleanupOwnerNonce,
        requestId: initiated.requestId,
        statusToken: initiated.statusToken,
      };
      await saveMobileAccountErasureStatusCapability(recoveredCapability);
      await clearMobileAccountErasurePreparation();
      const purgeResult = await purgeMobileAccountState({
        cleanupLease,
        isCleanupLeaseCurrent: auth.isAccountErasureCleanupLeaseCurrent,
        queryClient,
      });
      const finalizedCapability = {
        ...recoveredCapability,
        localCleanupBlockedByAnotherSession:
          accountErasureCleanupWasBlocked(purgeResult.errors) || undefined,
        localCleanupPending: purgeResult.errors.length > 0,
      };
      await saveMobileAccountErasureStatusCapability(finalizedCapability);
      setRecoverablePreparation(null);
      setCapability(finalizedCapability);
      setError(purgeResult.errors[0]?.message ?? null);
      await refresh(finalizedCapability);
    } catch (recoveryError: unknown) {
      captureException(
        new Error(
          accepted
            ? "Post-confirm account erasure recovery cleanup failed."
            : "Account erasure confirmation recovery failed.",
        ),
        { source: "account-erasure-mobile-confirm-recovery" },
      );
      setError(
        recoveryError instanceof Error ? recoveryError.message : "Deletion status recovery failed.",
      );
    } finally {
      if (cleanupLease) {
        auth.finishAccountErasureCleanup(cleanupLease);
      }
      setIsRecovering(false);
    }
  }

  async function forget(): Promise<void> {
    setError(null);
    try {
      await clearMobileAccountErasurePreparation();
      await clearMobileAccountErasureStatusCapability();
      setCapability(null);
      setRecoverablePreparation(null);
      setStatus(null);
      if (onForgetOverride) {
        onForgetOverride();
      } else {
        router.replace("/login");
      }
    } catch (forgetError: unknown) {
      captureException(forgetError, { source: "account-erasure-mobile-status-forget" });
      setError(
        forgetError instanceof Error
          ? forgetError.message
          : "Saved deletion status was not cleared.",
      );
    }
  }

  async function retryLocalCleanup(): Promise<void> {
    if (!capability) return;
    setError(null);
    let cleanupLease: AccountErasureCleanupLease | null = null;
    try {
      cleanupLease = auth.beginAccountErasureCleanupForNonce(capability.cleanupOwnerNonce);
      const result = await purgeMobileAccountState({
        cleanupLease,
        isCleanupLeaseCurrent: auth.isAccountErasureCleanupLeaseCurrent,
        queryClient,
      });
      const updated = {
        ...capability,
        localCleanupBlockedByAnotherSession:
          accountErasureCleanupWasBlocked(result.errors) || undefined,
        localCleanupPending: result.errors.length > 0,
      };
      await saveMobileAccountErasureStatusCapability(updated);
      setCapability(updated);
      setError(result.errors[0]?.message ?? null);
      if (!updated.localCleanupPending) {
        onLocalCleanupComplete?.();
      }
    } catch (saveError: unknown) {
      captureException(saveError, { source: "account-erasure-mobile-cleanup-status-save" });
      setError(
        saveError instanceof Error ? saveError.message : "Local cleanup status could not be saved.",
      );
    } finally {
      if (cleanupLease) {
        auth.finishAccountErasureCleanup(cleanupLease);
      }
    }
  }

  function signIn(): void {
    if (onSignInOverride) {
      onSignInOverride();
    } else {
      router.replace("/login");
    }
  }

  function contactSupport(): void {
    void Linking.openURL("mailto:asherlc@asherlc.com").catch((contactError: unknown) => {
      captureException(contactError, { source: "account-erasure-mobile-contact-support" });
      setError(
        contactError instanceof Error
          ? contactError.message
          : "The email application could not be opened.",
      );
    });
  }

  return (
    <AccountDeletionStatusView
      capability={capability}
      error={error}
      isLoading={isRestoring || isLoading}
      isRecovering={isRecovering}
      localCleanupPending={capability?.localCleanupPending === true}
      onContact={contactSupport}
      onForget={capability?.localCleanupPending ? undefined : () => void forget()}
      onRecover={recoverablePreparation ? () => void recover() : undefined}
      onRefresh={() => void refresh()}
      onRetryLocalCleanup={
        capability?.localCleanupPending ? () => void retryLocalCleanup() : undefined
      }
      onSignIn={signIn}
      status={status}
    />
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  content: {
    gap: spacing.md,
    padding: spacing.lg,
    paddingBottom: spacing.xl,
  },
  eyebrow: {
    color: colors.accent,
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 1.2,
  },
  title: {
    color: colors.text,
    fontSize: 28,
    fontWeight: "700",
  },
  intro: {
    color: colors.textSecondary,
    fontSize: 14,
    lineHeight: 21,
  },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.surfaceSecondary,
    borderRadius: radius.xl,
    borderWidth: 1,
    gap: spacing.sm,
    padding: spacing.lg,
  },
  loadingCard: {
    alignItems: "center",
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
    flexDirection: "row",
    gap: spacing.sm,
    padding: spacing.lg,
  },
  recoveryCard: {
    backgroundColor: "#fff8e8",
    borderColor: colors.warning,
    borderRadius: radius.xl,
    borderWidth: 1,
    gap: spacing.sm,
    padding: spacing.lg,
  },
  progressCard: {
    borderColor: colors.accent,
  },
  successCard: {
    borderColor: colors.positive,
  },
  dangerStatusCard: {
    borderColor: colors.danger,
  },
  cardTitle: {
    color: colors.text,
    fontSize: 19,
    fontWeight: "700",
  },
  cardText: {
    color: colors.textSecondary,
    fontSize: 14,
    lineHeight: 21,
  },
  mutedText: {
    color: colors.textSecondary,
    fontSize: 14,
  },
  loadingRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
  },
  statusLabel: {
    color: colors.textTertiary,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.8,
    textTransform: "uppercase",
  },
  details: {
    gap: spacing.xs,
    marginTop: spacing.xs,
  },
  detailLabel: {
    color: colors.textTertiary,
    fontSize: 12,
    fontWeight: "600",
    marginTop: spacing.xs,
  },
  detailValue: {
    color: colors.text,
    fontSize: 14,
  },
  requestId: {
    color: colors.text,
    fontFamily: "monospace",
    fontSize: 11,
  },
  errorText: {
    color: colors.danger,
    fontSize: 14,
    lineHeight: 20,
  },
  cleanupWarning: {
    borderColor: colors.danger,
    borderRadius: radius.lg,
    borderWidth: 1,
    gap: spacing.sm,
    padding: spacing.md,
  },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  primaryButton: {
    alignItems: "center",
    alignSelf: "flex-start",
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  dangerButton: {
    alignItems: "center",
    alignSelf: "flex-start",
    backgroundColor: colors.danger,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  disabledButton: {
    opacity: 0.5,
  },
  primaryButtonText: {
    color: colors.background,
    fontSize: 14,
    fontWeight: "700",
  },
  secondaryButton: {
    alignItems: "center",
    alignSelf: "flex-start",
    borderColor: colors.textTertiary,
    borderRadius: radius.md,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  secondaryButtonText: {
    color: colors.textSecondary,
    fontSize: 14,
    fontWeight: "600",
  },
  linkText: {
    color: colors.accent,
    fontSize: 14,
    fontWeight: "600",
    marginTop: spacing.xs,
  },
});
