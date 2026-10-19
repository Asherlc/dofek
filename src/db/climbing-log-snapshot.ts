import { sql } from "drizzle-orm";
import { type ClimbingLogSyncInput, persistClimbingLogEntries } from "./climbing-log-sync.ts";
import type { SyncDatabase } from "./index.ts";

/** Persist a complete, validated source logbook and retire missing occurrences atomically. */
export function persistClimbingLogSnapshot(db: SyncDatabase, input: ClimbingLogSyncInput) {
  return db.transaction(async (transaction) => {
    const result = await persistClimbingLogEntries(transaction, input);
    const present =
      result.logEntryIds.length === 0
        ? sql``
        : sql`AND id NOT IN (${sql.join(
            result.logEntryIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})`;
    await transaction.execute(sql`
      UPDATE fitness.climbing_log_entry SET provider_absent_at = NOW()
      WHERE user_id = ${input.userId} AND provider_id = ${input.providerId}
        AND provider_absent_at IS NULL AND external_id IS NOT NULL
        ${present}
    `);
    return result;
  });
}
