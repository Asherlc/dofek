import { sql } from "drizzle-orm";
import { type ClimbingLogSyncInput, persistClimbingLogEntries } from "./climbing-log-sync.ts";
import type { SyncDatabase } from "./index.ts";

/** Persist a complete, validated source logbook and retire missing occurrences atomically. */
export function persistClimbingLogSnapshot(db: SyncDatabase, input: ClimbingLogSyncInput) {
  return db.transaction(async (transaction) => {
    const result = await persistClimbingLogEntries(transaction, input);
    await transaction.execute(sql`
      UPDATE fitness.climbing_log_entry SET provider_absent_at = NOW()
      WHERE user_id = ${input.userId} AND provider_id = ${input.providerId}
        AND provider_absent_at IS NULL AND external_id IS NOT NULL
        AND id <> ALL(${sql.param(result.logEntryIds)}::uuid[])
    `);
    return result;
  });
}
