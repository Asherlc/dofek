import {
  type AccountErasureStatusCapability,
  accountErasureCleanupWasBlocked,
  describeAccountErasureStatus,
  type PublicAccountErasureStatus,
  PublicAccountErasureStatusSchema,
} from "@dofek/auth/account-erasure";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { purgeWebAccountState } from "../lib/account-erasure-purge.ts";
import {
  clearAccountErasurePreparation,
  clearAccountErasureStatusCapability,
  loadAccountErasureStatusCapability,
  loadAnyAccountErasurePreparation,
  saveAccountErasureStatusCapability,
} from "../lib/account-erasure-storage.ts";
import { type AccountErasureCleanupLease, useAuth } from "../lib/auth-context.tsx";
import { disablePostHogForAccountErasure } from "../lib/posthog.ts";
import { captureException } from "../lib/telemetry.ts";
import { trpc } from "../lib/trpc.ts";

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
  localCleanupPending: boolean;
  isRecovering?: boolean;
  onForget?: (() => void) | undefined;
  onRecover?: (() => void) | undefined;
  onRefresh: () => void;
  onRetryLocalCleanup?: (() => void) | undefined;
  status: PublicAccountErasureStatus | null;
}

export function AccountDeletionStatusView({
  capability,
  error,
  isLoading,
  localCleanupPending,
  isRecovering = false,
  onForget,
  onRecover,
  onRefresh,
  onRetryLocalCleanup,
  status,
}: AccountDeletionStatusViewProps) {
  const presentation = status ? describeAccountErasureStatus(status) : null;
  const toneClass =
    presentation?.tone === "success"
      ? "border-emerald-700/50 bg-emerald-950/20"
      : presentation?.tone === "danger"
        ? "border-red-800/60 bg-red-950/20"
        : "border-accent/40 bg-accent/5";

  return (
    <main className="min-h-screen bg-page px-4 py-12 text-foreground sm:py-20">
      <div className="mx-auto max-w-2xl space-y-6">
        <header className="space-y-2">
          <Link to="/" className="text-sm text-accent hover:underline">
            Dofek
          </Link>
          <h1 className="text-3xl font-semibold">Account deletion status</h1>
          <p className="text-sm text-muted">
            This page uses a capability saved in this browser. It does not require an active Dofek
            session.
          </p>
        </header>

        {onRecover && !capability ? (
          <section className="rounded-xl border border-amber-700/50 bg-amber-950/20 p-5 space-y-3">
            <h2 className="text-lg font-semibold">Recover an accepted request</h2>
            <p className="text-sm text-subtle">
              The confirmation response may have been interrupted after your session was revoked.
              Reusing the saved preparation safely recovers the same request and status capability.
            </p>
            <button
              type="button"
              disabled={isRecovering}
              onClick={onRecover}
              className="rounded bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              {isRecovering ? "Recovering..." : "Recover deletion status"}
            </button>
          </section>
        ) : null}

        {!capability && !onRecover ? (
          <section className="rounded-xl border border-border bg-surface p-5 space-y-4">
            <h2 className="text-lg font-semibold">No saved request</h2>
            <p className="mt-2 text-sm text-muted">
              This browser does not have an account deletion status capability. Start deletion from
              Settings while signed in, or return to the browser where you made the request.
            </p>
            <Link
              to="/login"
              search={{ returnTo: "/settings" }}
              className="inline-flex rounded bg-accent px-4 py-2 text-sm font-semibold text-white"
            >
              Sign in to request account deletion
            </Link>
          </section>
        ) : null}

        {capability ? (
          <section className={`rounded-xl border p-5 space-y-4 ${toneClass}`}>
            {isLoading && !status ? (
              <output className="flex items-center gap-3 text-sm text-muted">
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-accent border-t-transparent" />
                Loading deletion status...
              </output>
            ) : null}

            {presentation && status ? (
              <>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted">
                    {status.status.replaceAll("_", " ")}
                  </p>
                  <h2 className="mt-1 text-xl font-semibold">{presentation.title}</h2>
                  <p className="mt-2 text-sm leading-relaxed text-subtle">{presentation.detail}</p>
                </div>
                <dl className="grid gap-3 text-sm sm:grid-cols-2">
                  <div>
                    <dt className="text-xs text-muted">Request ID</dt>
                    <dd className="break-all font-mono text-xs">{status.id}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted">Requested</dt>
                    <dd>{dateTimeFormatter.format(new Date(status.requestedAt))}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted">Current phase</dt>
                    <dd>{formatPhase(status.currentPhase)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted">Final retention verification by</dt>
                    <dd>{dateTimeFormatter.format(new Date(status.retentionUntil))}</dd>
                  </div>
                </dl>
              </>
            ) : null}

            {error ? (
              <p role="alert" className="text-sm text-red-300">
                {error}
              </p>
            ) : null}

            {localCleanupPending ? (
              <div role="alert" className="space-y-2 rounded border border-red-800 p-3">
                <p className="text-sm text-red-300">
                  {capability.localCleanupBlockedByAnotherSession
                    ? "Local cleanup belongs to the deleted account, but another account is active in this browser. Sign out of that account before retrying cleanup."
                    : "Some browser data could not be cleared. Close other Dofek tabs, then retry local cleanup. Your deletion request and saved status capability are safe."}
                </p>
                {onRetryLocalCleanup ? (
                  <button
                    type="button"
                    onClick={onRetryLocalCleanup}
                    className="rounded bg-red-700 px-3 py-2 text-sm font-medium text-white"
                  >
                    Retry local cleanup
                  </button>
                ) : null}
              </div>
            ) : null}

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={onRefresh}
                disabled={isLoading}
                className="rounded bg-accent px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                {isLoading ? "Checking..." : "Check again"}
              </button>
              {onForget && !localCleanupPending ? (
                <button
                  type="button"
                  onClick={onForget}
                  className="rounded border border-border-strong px-3 py-2 text-sm text-subtle"
                >
                  Forget saved status
                </button>
              ) : null}
            </div>
          </section>
        ) : null}

        <section className="space-y-3 rounded-xl border border-border bg-surface p-5 text-sm text-muted">
          <h2 className="font-semibold text-foreground">What Dofek can delete</h2>
          <p>
            Dofek clears its local caches and deletes nutrition samples the Dofek app wrote to
            HealthKit. HealthKit and Core Motion source records remain controlled by iOS; you can
            review or delete those records in Apple&apos;s settings and Health app.
          </p>
          <p>
            Payment processors may retain legally required transaction records after Dofek&apos;s
            application-data deletion finishes. Those records are not treated as active Dofek
            account data.
          </p>
          <p>
            <Link to="/privacy" className="text-accent hover:underline">
              Read the retention and deletion disclosure
            </Link>
          </p>
          <p>
            <a href="mailto:asherlc@asherlc.com" className="text-accent hover:underline">
              Contact deletion support
            </a>
          </p>
        </section>
      </div>
    </main>
  );
}

export function AccountDeletionStatusPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [capability, setCapability] = useState(loadAccountErasureStatusCapability);
  const [recoverablePreparation, setRecoverablePreparation] = useState(() => {
    const preparation = loadAnyAccountErasurePreparation();
    return preparation && "confirmationAttemptedAt" in preparation ? preparation : null;
  });
  const [status, setStatus] = useState<PublicAccountErasureStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isRecovering, setIsRecovering] = useState(false);
  const { mutateAsync: requestStatus } = trpc.accountErasure.status.useMutation();
  const { mutateAsync: recoverConfirmation } = trpc.accountErasure.confirm.useMutation();

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
          source: "account-erasure-public-status",
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
    const interval = window.setInterval(() => void refresh(capability), 30_000);
    return () => window.clearInterval(interval);
  }, [capability, refresh]);

  async function recover(): Promise<void> {
    if (!recoverablePreparation) return;
    setIsRecovering(true);
    setError(null);
    let accepted = false;
    let cleanupLease: AccountErasureCleanupLease | null = null;
    try {
      cleanupLease = await auth.beginAccountErasureCleanupForNonce(
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
      saveAccountErasureStatusCapability(recoveredCapability);
      if (auth.isAccountErasureCleanupLeaseCurrent(cleanupLease)) {
        disablePostHogForAccountErasure();
      }
      clearAccountErasurePreparation();
      const purgeResult = await purgeWebAccountState({
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
      saveAccountErasureStatusCapability(finalizedCapability);
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
        { source: "account-erasure-confirm-recovery" },
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

  function forget(): void {
    clearAccountErasurePreparation();
    clearAccountErasureStatusCapability();
    setCapability(null);
    setRecoverablePreparation(null);
    setStatus(null);
    setError(null);
    void navigate({ to: "/login" });
  }

  async function retryLocalCleanup(): Promise<void> {
    if (!capability) return;
    setError(null);
    let cleanupLease: AccountErasureCleanupLease | null = null;
    try {
      cleanupLease = await auth.beginAccountErasureCleanupForNonce(capability.cleanupOwnerNonce);
      if (auth.isAccountErasureCleanupLeaseCurrent(cleanupLease)) {
        disablePostHogForAccountErasure();
      }
      const result = await purgeWebAccountState({
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
      saveAccountErasureStatusCapability(updated);
      setCapability(updated);
      setError(result.errors[0]?.message ?? null);
    } catch (cleanupError: unknown) {
      captureException(new Error("Local account erasure cleanup retry failed."), {
        source: "account-erasure-cleanup-retry",
      });
      setError(
        cleanupError instanceof Error
          ? cleanupError.message
          : "Local account cleanup could not be completed.",
      );
    } finally {
      if (cleanupLease) {
        auth.finishAccountErasureCleanup(cleanupLease);
      }
    }
  }

  return (
    <AccountDeletionStatusView
      capability={capability}
      error={error}
      isLoading={isLoading}
      isRecovering={isRecovering}
      localCleanupPending={capability?.localCleanupPending === true}
      onForget={capability?.localCleanupPending ? undefined : forget}
      onRecover={recoverablePreparation ? () => void recover() : undefined}
      onRefresh={() => void refresh()}
      onRetryLocalCleanup={
        capability?.localCleanupPending ? () => void retryLocalCleanup() : undefined
      }
      status={status}
    />
  );
}
