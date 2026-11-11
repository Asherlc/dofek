import { sql } from "drizzle-orm";
import { z } from "zod";
import { type ClimbingLogSyncInput, persistClimbingLogEntries } from "./climbing-log-sync.ts";
import type { SyncDatabase } from "./index.ts";
import {
  markProviderActivityAbsent,
  markProviderActivityPresent,
} from "./provider-activity-absence.ts";
import { executeWithSchema } from "./typed-sql.ts";

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
    const observations = await executeWithSchema(
      transaction,
      z.object({ external_id: z.string(), absent: z.boolean() }),
      sql`
      SELECT point.external_id, entry.provider_absent_at IS NOT NULL AS absent
      FROM fitness.activity AS point
      JOIN fitness.climbing_log_entry AS entry
        ON entry.user_id = point.user_id AND entry.provider_id = point.provider_id
        AND entry.external_id = point.external_id
      WHERE point.user_id = ${input.userId} AND point.provider_id = ${input.providerId}
        AND point.provider_type = 'climbing_log'
        AND (entry.provider_absent_at IS NOT NULL OR
          point.external_id = ANY(${sql.param(retainedExternalIds)}::text[]))
    `,
    );
    for (const observation of observations) {
      const mark = {
        userId: input.userId,
        providerId: input.providerId,
        externalId: observation.external_id,
      };
      if (observation.absent) await markProviderActivityAbsent(transaction, mark);
      else await markProviderActivityPresent(transaction, mark);
    }
    return result;
  });
}
