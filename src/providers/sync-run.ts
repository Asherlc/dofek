import type { SyncDatabase } from "../db/index.ts";
import type { MetricStreamEventPublisher } from "../metric-stream/redpanda-producer.ts";
import type { SyncWindow } from "./sync-window.ts";

/**
 * Progress callback for reporting sync progress from within a provider.
 * @param percentage - Percentage complete (0-100)
 * @param message - Human-readable status message
 */
export type SyncProgressCallback = (percentage: number, message: string) => void;

export interface SyncCheckpointStore {
  load(): Promise<unknown | null>;
  save(checkpoint: unknown): Promise<void>;
  clear(): Promise<void>;
}

/**
 * Options for a sync run, passed as a bag so we can extend without adding positional params.
 */
export interface SyncOptions {
  /** Callback to report progress (0-100%) */
  onProgress?: SyncProgressCallback;
  /** User ID for attributing sync log entries */
  userId?: string;
  /** Persisted IANA home zone, used only as a local-time fallback during ingest. */
  homeTimezone?: string | null;
  /** Provider-owned checkpoint state for retryable job resumes */
  checkpoint?: SyncCheckpointStore;
  /** Optional publisher override for metric-stream writers. */
  metricStreamPublisher?: MetricStreamEventPublisher;
  /** Enqueue the next step of a multi-job provider sync (e.g. WHOOP). */
  enqueueSyncContinuation?: (checkpoint: unknown) => Promise<void>;
}

export type SyncRunParams = {
  db: SyncDatabase;
  window: SyncWindow;
} & SyncOptions;

/** Bundles per-run sync inputs for a provider invocation. */
export class SyncRun {
  readonly db: SyncDatabase;
  readonly window: SyncWindow;
  readonly options: SyncOptions;

  constructor({
    db,
    window,
    onProgress,
    userId,
    homeTimezone,
    checkpoint,
    metricStreamPublisher,
    enqueueSyncContinuation,
  }: SyncRunParams) {
    this.db = db;
    this.window = window;
    this.options = {
      onProgress,
      userId,
      homeTimezone,
      checkpoint,
      metricStreamPublisher,
      enqueueSyncContinuation,
    };
  }
}
