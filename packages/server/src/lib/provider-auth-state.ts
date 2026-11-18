import { providerSyncAccessIssue } from "@dofek/providers/sync-log-presentation";
import type { ProviderAuthFailureReason } from "dofek/providers/auth-errors";

export function hasCurrentProviderAuthFailure(
  authFailureReason: ProviderAuthFailureReason | null,
  errorSyncedAt: Date,
  tokenUpdatedAt?: Date,
  errorMessage?: string | null,
): boolean {
  if (!authFailureReason || providerSyncAccessIssue(errorMessage)) return false;
  return !tokenUpdatedAt || errorSyncedAt > tokenUpdatedAt;
}
