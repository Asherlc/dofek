import type { SyncDatabase } from "../db/index.ts";
import type { SyncWindow } from "./sync-window.ts";
import type { SyncOptions } from "./types.ts";

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
    checkpoint,
    metricStreamPublisher,
  }: SyncRunParams) {
    this.db = db;
    this.window = window;
    this.options = { onProgress, userId, checkpoint, metricStreamPublisher };
  }
}
