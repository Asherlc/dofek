import type { SyncDatabase } from "./index.ts";
import { syncLog } from "./schema.ts";

export interface SyncLogEntry {
  providerId: string;
  dataType: string;
  status: "success" | "error";
  recordCount?: number;
  errorMessage?: string;
  durationMs?: number;
  /** User ID for this sync log entry. When omitted, falls back to the DB default (DEFAULT_USER_ID). */
  userId?: string;
}

/**
 * Record a sync attempt for a specific provider + data type.
 */
export async function logSync(db: SyncDatabase, entry: SyncLogEntry): Promise<void> {
  await db.insert(syncLog).values({
    providerId: entry.providerId,
    dataType: entry.dataType,
    status: entry.status,
    recordCount: entry.recordCount ?? 0,
    errorMessage: entry.errorMessage,
    durationMs: entry.durationMs,
    userId: entry.userId,
  });
}

/**
 * Helper to time and log a sync operation.
 * Returns the result of the operation, logs success or error.
 */
export async function withSyncLog<T>(
  db: SyncDatabase,
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
