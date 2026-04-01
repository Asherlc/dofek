import type { SyncDatabase } from "./index.ts";
import { syncLog } from "./schema.ts";
import { getTokenUserId } from "./token-user-context.ts";

export interface SyncLogEntry {
  providerId: string;
  dataType: string;
  status: "success" | "error";
  recordCount?: number;
  errorMessage?: string;
  durationMs?: number;
  /** User ID for this sync log entry. */
  userId?: string;
}

function resolveUserId(userId?: string): string {
  const scopedUserId = userId ?? getTokenUserId();
  if (!scopedUserId) {
    throw new Error("sync-log requires userId (explicit or token context)");
  }
  return scopedUserId;
}

/**
 * Record a sync attempt for a specific provider + data type.
 */
export async function logSync(db: SyncDatabase, entry: SyncLogEntry): Promise<void> {
  const scopedUserId = resolveUserId(entry.userId);
  await db.insert(syncLog).values({
    providerId: entry.providerId,
    dataType: entry.dataType,
    status: entry.status,
    recordCount: entry.recordCount ?? 0,
    errorMessage: entry.errorMessage,
    durationMs: entry.durationMs,
    userId: scopedUserId,
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
  userId?: string,
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
      userId,
    });
    return result;
  } catch (err) {
    await logSync(db, {
      providerId,
      dataType,
      status: "error",
      errorMessage: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - start,
      userId,
    });
    throw err;
  }
}
