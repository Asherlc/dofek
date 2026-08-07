import type { ProviderAuthFailureReason } from "dofek/providers/auth-errors";

export function hasCurrentProviderAuthFailure(
  authFailureReason: ProviderAuthFailureReason | null,
  errorSyncedAt: Date,
  tokenUpdatedAt?: Date,
): boolean {
  if (!authFailureReason) return false;
  return !tokenUpdatedAt || errorSyncedAt > tokenUpdatedAt;
}
