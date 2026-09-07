import { captureException } from "dofek/lib/error-reporting";
import { sql } from "drizzle-orm";
import { z } from "zod";
import {
  authFailureReasonFromError,
  type ProviderAuthFailureReason,
} from "../providers/auth-errors.ts";
import type { SyncDegradation, SyncDegradationKind } from "../sync/sync-degradation.ts";
import { reportSyncDegradation } from "../sync/sync-degradation-reporting.ts";
import { executeWithSchema } from "./execute-with-schema.ts";
import type { Database, SyncDatabase, TransactionDatabase } from "./index.ts";
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

function hasTransaction(db: SyncDatabase): db is SyncDatabase & Pick<Database, "transaction"> {
  return "transaction" in db && typeof db.transaction === "function";
}

async function insertSyncLog(
  db: Pick<SyncDatabase, "insert">,
  entry: SyncLogEntry,
  userId: string,
): Promise<void> {
  await db.insert(syncLog).values({
    providerId: entry.providerId,
    dataType: entry.dataType,
    status: entry.status,
    recordCount: entry.recordCount ?? 0,
    errorMessage: entry.errorMessage,
    authFailureReason: entry.authFailureReason,
    degradationKind: entry.degradationKind,
    durationMs: entry.durationMs,
    userId,
    origin: entry.origin ?? "unknown",
  });
}

async function insertScheduledFailureAndCount(
  db: SyncDatabase,
  entry: SyncLogEntry,
  userId: string,
): Promise<number> {
  if (!hasTransaction(db)) {
    throw new Error("Scheduled sync failure logging requires a transactional database");
  }

  return db.transaction(async (transaction: TransactionDatabase) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${userId}:${entry.providerId}`}, 0))`,
    );
    await insertSyncLog(transaction, entry, userId);

    const [row] = await executeWithSchema(
      transaction,
      consecutiveFailureRowSchema,
      sql`WITH ordered_attempts AS (
            SELECT status,
              ROW_NUMBER() OVER (ORDER BY synced_at DESC, id DESC) AS attempt_number
            FROM fitness.sync_log
            WHERE user_id = ${userId}
              AND provider_id = ${entry.providerId}
              AND data_type = 'sync'
              AND origin = 'scheduled'
          ), last_success AS (
            SELECT MIN(attempt_number) AS attempt_number
            FROM ordered_attempts
            WHERE status = 'success'
          )
          SELECT COUNT(*)::int AS consecutive_failures
          FROM ordered_attempts
          CROSS JOIN last_success
          WHERE status = 'error'
            AND ordered_attempts.attempt_number < COALESCE(
              last_success.attempt_number,
              9223372036854775807
            )`,
    );
    return row?.consecutive_failures ?? 0;
  });
}

/**
 * Record a sync attempt for a specific provider + data type.
 */
export async function logSync(db: SyncDatabase, entry: SyncLogEntry): Promise<void> {
  const scopedUserId = resolveUserId(entry.userId);
  const isScheduledTopLevelFailure =
    entry.origin === "scheduled" && entry.dataType === "sync" && entry.status === "error";
  let consecutiveFailures = 0;
  if (isScheduledTopLevelFailure) {
    consecutiveFailures = await insertScheduledFailureAndCount(db, entry, scopedUserId);
  } else {
    await insertSyncLog(db, entry, scopedUserId);
  }

  if (consecutiveFailures === 2) {
    captureException(new Error(`Provider ${entry.providerId} failed two scheduled syncs`), {
      level: "warning",
      tags: {
        provider: entry.providerId,
        operation: "scheduled-provider-sync",
        consecutive_failures: "2",
      },
      extra: {
        user_id: scopedUserId,
        error_message: entry.errorMessage,
      },
    });
  }
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
