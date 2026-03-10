import type { Database } from "./index.js";
import { syncLog } from "./schema.js";

export interface SyncLogEntry {
  providerId: string;
  dataType: string;
  status: "success" | "error";
  recordCount?: number;
  errorMessage?: string;
  durationMs?: number;
}

/**
 * Record a sync attempt for a specific provider + data type.
 */
export async function logSync(db: Database, entry: SyncLogEntry): Promise<void> {
  await db.insert(syncLog).values({
    providerId: entry.providerId,
    dataType: entry.dataType,
    status: entry.status,
    recordCount: entry.recordCount ?? 0,
    errorMessage: entry.errorMessage,
    durationMs: entry.durationMs,
  });
}

/**
 * Helper to time and log a sync operation.
 * Returns the result of the operation, logs success or error.
 */
export async function withSyncLog<T>(
  db: Database,
  providerId: string,
  dataType: string,
  fn: () => Promise<{ recordCount: number; result: T }>,
): Promise<T> {
  const start = Date.now();
  try {
    const { recordCount, result } = await fn();
    await logSync(db, {
      providerId,
      dataType,
      status: "success",
      recordCount,
      durationMs: Date.now() - start,
    });
    return result;
  } catch (err) {
    await logSync(db, {
      providerId,
      dataType,
      status: "error",
      errorMessage: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - start,
    });
    throw err;
  }
}
