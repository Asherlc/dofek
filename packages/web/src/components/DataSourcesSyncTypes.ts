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
}
