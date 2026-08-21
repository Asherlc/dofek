import { accountErasureCleanupWasBlocked } from "@dofek/auth/account-erasure";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { purgeWebAccountState } from "../lib/account-erasure-purge.ts";
import {
  clearAccountErasurePreparation,
  loadAccountErasurePreparation,
  markAccountErasureConfirmationAttempted,
  saveAccountErasurePreparation,
  saveAccountErasureStatusCapability,
} from "../lib/account-erasure-storage.ts";
import { type AccountErasureCleanupLease, useAuth } from "../lib/auth-context.tsx";
import { disablePostHogForAccountErasure } from "../lib/posthog.ts";
import { captureException } from "../lib/telemetry.ts";
import { trpc } from "../lib/trpc.ts";

function isUnexpired(expiresAt: string): boolean {
  return new Date(expiresAt).getTime() > Date.now();
}

export function AccountErasurePanel() {
  const auth = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const userId = auth.user?.id;
  const [confirmation, setConfirmation] = useState("");
  const [isExpanded, setIsExpanded] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [preparation, setPreparation] = useState(() => {
    const saved = userId ? loadAccountErasurePreparation(userId) : null;
    return saved && isUnexpired(saved.expiresAt) ? saved : null;
  });
  const prepareMutation = trpc.accountErasure.prepare.useMutation();
  const confirmMutation = trpc.accountErasure.confirm.useMutation();

  async function prepareDeletion(): Promise<void> {
    if (!userId || confirmation !== "DELETE") return;
    setLocalError(null);
    try {
      const prepared = await prepareMutation.mutateAsync({ confirmation: "DELETE" });
      const capability = {
        ...prepared,
        ownerUserId: userId,
      };
      saveAccountErasurePreparation(capability);
      setPreparation(capability);
    } catch (error: unknown) {
      captureException(error, { source: "account-erasure-prepare" });
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
      cleanupLease = await auth.beginAccountErasureCleanup(preparation.ownerUserId);
      const attempted = markAccountErasureConfirmationAttempted(cleanupLease.cleanupOwnerNonce);
      confirmationAttempted = true;
      disablePostHogForAccountErasure();
      const initiated = await confirmMutation.mutateAsync({
        preparationToken: attempted.preparationToken,
      });
      accepted = true;
      const statusCapability = {
        cleanupOwnerNonce: attempted.cleanupOwnerNonce,
        requestId: initiated.requestId,
        statusToken: initiated.statusToken,
      };
      saveAccountErasureStatusCapability(statusCapability);
      clearAccountErasurePreparation();
      const purgeResult = await purgeWebAccountState({
        cleanupLease,
        isCleanupLeaseCurrent: auth.isAccountErasureCleanupLeaseCurrent,
        queryClient,
      });
      if (purgeResult.errors.length > 0) {
        saveAccountErasureStatusCapability({
          ...statusCapability,
          localCleanupBlockedByAnotherSession:
            accountErasureCleanupWasBlocked(purgeResult.errors) || undefined,
          localCleanupPending: true,
        });
      }
      await navigate({ to: "/account-deletion" });
    } catch (error: unknown) {
      captureException(
        accepted
          ? new Error("Post-confirm account erasure cleanup failed.")
          : new Error("Account erasure confirmation failed."),
        { source: "account-erasure-confirm" },
      );
      const message = error instanceof Error ? error.message : String(error);
      setLocalError(
        accepted
          ? `${message} Account deletion was accepted and your session was closed. Recover the public deletion status from the saved preparation.`
          : confirmationAttempted
            ? `${message} The confirmation response could not be verified. Recover it from the public deletion-status page; the saved recovery capability contains no account identifier.`
            : `${message} No confirmation request was sent. Your account-specific preparation remains saved; sign in to the same account and retry from Settings.`,
      );
      if (accepted || confirmationAttempted) {
        await navigate({ to: "/account-deletion" });
      }
    } finally {
      if (cleanupLease) {
        auth.finishAccountErasureCleanup(cleanupLease);
      }
    }
  }

  const isPending = prepareMutation.isPending || confirmMutation.isPending;

  if (!isExpanded && !preparation) {
    return (
      <button
        type="button"
        onClick={() => setIsExpanded(true)}
        className="rounded bg-accent/10 px-3 py-1.5 text-xs text-red-400 transition-colors hover:bg-surface-hover"
      >
        Delete account
      </button>
    );
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2 text-xs text-muted">
        <p>
          This permanently closes your Dofek account, disconnects providers, and starts deletion of
          Dofek-held account and health data. It cannot be undone.
        </p>
        <p>
          HealthKit and Core Motion records remain controlled by iOS. Dofek removes nutrition
          samples it wrote, but cannot delete operating-system-owned source history. Payment
          processors may retain transaction records when legally required.
        </p>
      </div>

      {preparation ? (
        <div className="space-y-3 rounded border border-red-900/70 bg-red-950/20 p-3">
          <p className="text-xs text-red-200">
            Final confirmation: deletion will start immediately, your session will end, and new
            writes will be blocked.
          </p>
          <button
            type="button"
            onClick={() => void confirmDeletion()}
            disabled={isPending}
            className="rounded bg-red-600 px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-red-500 disabled:opacity-50"
          >
            {confirmMutation.isPending
              ? "Starting account deletion..."
              : "Permanently delete my account"}
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          <label className="block space-y-1">
            <span className="text-xs text-subtle">Type &quot;DELETE&quot; to continue</span>
            <input
              aria-label='Type "DELETE" to continue'
              autoComplete="off"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              className="w-full rounded border border-red-900/70 bg-surface px-3 py-2 text-sm text-foreground"
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void prepareDeletion()}
              disabled={confirmation !== "DELETE" || isPending}
              className="rounded border border-red-700 px-3 py-2 text-xs font-semibold text-red-300 transition-colors hover:bg-red-950/30 disabled:opacity-50"
            >
              {prepareMutation.isPending ? "Preparing..." : "Prepare account deletion"}
            </button>
            <button
              type="button"
              onClick={() => {
                setIsExpanded(false);
                setConfirmation("");
                setLocalError(null);
              }}
              disabled={isPending}
              className="rounded bg-accent/10 px-3 py-2 text-xs text-foreground"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {localError ? (
        <p role="alert" className="text-xs text-red-400">
          {localError}
        </p>
      ) : null}
    </div>
  );
}
