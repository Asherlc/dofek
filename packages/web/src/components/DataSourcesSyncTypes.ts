export type SyncStatus = "idle" | "syncing" | "done" | "error";

export interface ProviderState {
  status: SyncStatus;
  message?: string;
  percentage?: number;
}

export interface SyncLogEntry {
  id: string;
  status: string;
  syncedAt: string;
  recordCount: number | null;
  durationMs: number | null;
  dataType: string;
  errorMessage: string | null;
  authFailureReason: string | null;
}

export type ProviderSyncFreshness =
  | { status: "unknown"; label: "Sync status unknown"; description: string }
  | { status: "current"; label: "Sync current" }
  | { status: "deferred"; label: "Sync deferred"; description: string }
  | { status: "overdue"; label: "Sync overdue"; description: string };

/** Row returned by sync.providers — registered OAuth/import and push-only providers. */
export interface SyncProviderSummary {
  id: string;
  name: string;
  description: string | null;
  authType: string;
  tokenAuth: { label: string; instructionsUrl: string } | null;
  authorized: boolean;
  lastSyncedAt: string | null;
  lastSuccessfulSyncAt: string | null;
  syncFreshness: ProviderSyncFreshness | null;
  importOnly: boolean;
  pushOnly: boolean;
  needsReauth: boolean;
  recentLogs: SyncLogEntry[];
}
