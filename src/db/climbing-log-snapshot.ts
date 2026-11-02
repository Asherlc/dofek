import { sql } from "drizzle-orm";
import { type ClimbingLogSyncInput, persistClimbingLogEntries } from "./climbing-log-sync.ts";
import type { SyncDatabase } from "./index.ts";

/** Reconcile a validated logbook, retaining occurrences still supported by other source records. */
export function persistClimbingLogSnapshot(
  db: SyncDatabase,
  input: ClimbingLogSyncInput,
  retainedExternalIds: readonly string[] = [],
) {
  return db.transaction(async (transaction) => {
    const result = await persistClimbingLogEntries(transaction, input);
    await transaction.execute(sql`
      UPDATE fitness.climbing_log_entry SET provider_absent_at = NOW()
      WHERE user_id = ${input.userId} AND provider_id = ${input.providerId}
        AND provider_absent_at IS NULL AND external_id IS NOT NULL
        AND id <> ALL(${sql.param(result.logEntryIds)}::uuid[])
        ${retainedExternalIds.length ? sql`AND external_id <> ALL(${sql.param(retainedExternalIds)}::text[])` : sql``}
    `);
    if (retainedExternalIds.length)
      await transaction.execute(sql`
        UPDATE fitness.climbing_log_entry SET provider_absent_at = NULL
        WHERE user_id = ${input.userId} AND provider_id = ${input.providerId}
          AND provider_absent_at IS NOT NULL
          AND external_id = ANY(${sql.param(retainedExternalIds)}::text[])
      `);
    return result;
  });
}
