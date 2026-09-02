import { sql } from "drizzle-orm";
import { captureException } from "dofek/lib/error-reporting";
import { z } from "zod";
import {
  authFailureReasonFromError,
  type ProviderAuthFailureReason,
} from "../providers/auth-errors.ts";
import type { SyncDegradation, SyncDegradationKind } from "../sync/sync-degradation.ts";
import { reportSyncDegradation } from "../sync/sync-degradation-reporting.ts";
import type { SyncDatabase } from "./index.ts";
import { executeWithSchema } from "./execute-with-schema.ts";
import { type SyncLogOrigin, syncLog } from "./schema/events.ts";
import { getTokenUserId } from "./token-user-context.ts";

export interface SyncLogEntry {
  providerId: string;
  dataType: string;
  status: "success" | "error" | "degraded";
  recordCount?: number;
  errorMessage?: string;
  authFailureReason?: ProviderAuthFailureReason;
  degradationKind?: SyncDegradationKind;
  durationMs?: number;
  /** User ID for this sync log entry. */
  userId?: string;
  origin?: SyncLogOrigin;
}

export class PartialSyncError extends Error {
  readonly recordCount: number;
  override readonly cause: unknown;

  constructor(message: string, recordCount: number, cause: unknown) {
    super(message);
    this.name = "PartialSyncError";
    this.recordCount = recordCount;
    this.cause = cause;
  }
}

function resolveUserId(userId?: string): string {
  const scopedUserId = userId ?? getTokenUserId();
  if (!scopedUserId) {
    throw new Error("sync-log requires userId (explicit or token context)");
  }
  return scopedUserId;
}

const consecutiveFailureRowSchema = z.object({
  consecutive_failures: z.coerce.number().int().nonnegative(),
});

async function reportConsecutiveScheduledFailures(
  db: SyncDatabase,
  entry: SyncLogEntry,
  userId: string,
): Promise<void> {
  if (entry.origin !== "scheduled" || entry.dataType !== "sync" || entry.status !== "error") {
    return;
  }

  try {
    const [row] = await executeWithSchema(
      db,
      consecutiveFailureRowSchema,
      sql`WITH last_success AS (
            SELECT MAX(synced_at) AS synced_at
            FROM fitness.sync_log
            WHERE user_id = ${userId}
              AND provider_id = ${entry.providerId}
              AND data_type = 'sync'
              AND origin = 'scheduled'
              AND status = 'success'
          )
          SELECT COUNT(*)::int AS consecutive_failures
          FROM fitness.sync_log
          CROSS JOIN last_success
          WHERE user_id = ${userId}
            AND provider_id = ${entry.providerId}
            AND data_type = 'sync'
            AND origin = 'scheduled'
            AND status = 'error'
            AND synced_at > COALESCE(last_success.synced_at, '-infinity'::timestamptz)`,
    );

    if (row?.consecutive_failures === 2) {
      captureException(new Error(`Provider ${entry.providerId} failed two scheduled syncs`), {
        level: "warning",
        tags: {
          provider: entry.providerId,
          operation: "scheduled-provider-sync",
          consecutive_failures: "2",
        },
        extra: {
          user_id: userId,
          error_message: entry.errorMessage,
        },
      });
    }
  } catch (error) {
    captureException(error, {
      tags: { provider: entry.providerId, operation: "scheduled-provider-sync-alert" },
      extra: { user_id: userId },
    });
  }
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
    authFailureReason: entry.authFailureReason,
    degradationKind: entry.degradationKind,
    durationMs: entry.durationMs,
    userId: scopedUserId,
    origin: entry.origin ?? "unknown",
  });
  await reportConsecutiveScheduledFailures(db, entry, scopedUserId);
}

/**
 * Helper to time and log a sync operation.
 * Returns the result of the operation, logs success or error.
 */
export async function withSyncLog<T>(
  db: SyncDatabase,
  providerId: string,
  dataType: string,
  fn: () => Promise<{ recordCount: number; result: T; degradations?: SyncDegradation[] }>,
  userId?: string,
): Promise<T> {
  const start = Date.now();
  try {
    const { recordCount, result, degradations = [] } = await fn();
    for (const degradation of degradations) {
      reportSyncDegradation(degradation);
    }
    const firstDegradation = degradations[0];
    await logSync(db, {
      providerId,
      dataType,
      status: firstDegradation ? "degraded" : "success",
      recordCount,
      errorMessage: firstDegradation?.message,
      degradationKind: firstDegradation?.kind,
      durationMs: Date.now() - start,
      userId,
    });
    return result;
  } catch (err) {
    const authFailureSource = err instanceof PartialSyncError ? err.cause : err;
    await logSync(db, {
      providerId,
      dataType,
      status: "error",
      recordCount: err instanceof PartialSyncError ? err.recordCount : undefined,
      errorMessage: err instanceof Error ? err.message : String(err),
      authFailureReason: authFailureReasonFromError(authFailureSource),
      durationMs: Date.now() - start,
      userId,
    });
    throw err;
  }
}
