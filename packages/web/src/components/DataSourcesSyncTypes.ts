export type SyncStatus = "idle" | "syncing" | "done" | "error";

export interface ProviderState {
  status: SyncStatus;
  message?: string;
  percentage?: number;
}

export interface SyncLogEntry {
  status: string;
  syncedAt: string;
  recordCount: number | null;
  durationMs: number | null;
  errorMessage: string | null;
  authFailureReason: string | null;
}

/** Row returned by sync.providers — registered OAuth/import and push-only providers. */
export interface SyncProviderSummary {
  id: string;
  name: string;
  description: string | null;
  authType: string;
  tokenAuth: { label: string; instructionsUrl: string } | null;
  authorized: boolean;
  lastSyncedAt: string | null;
  importOnly: boolean;
  pushOnly: boolean;
  needsReauth: boolean;
}
