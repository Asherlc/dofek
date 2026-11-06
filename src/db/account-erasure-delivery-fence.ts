import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema, type SchemaExecutionDatabase } from "./typed-sql.ts";

/**
 * Connection surface the delivery fence actually uses (locks + fence query +
 * analytics completion). Same execute contract as SchemaExecutionDatabase.
 */
export type AccountErasureDeliveryFenceConnection = SchemaExecutionDatabase;

/**
 * Database surface the delivery fence actually consumes. Production `Database`
 * satisfies this structurally; unit fixtures implement it without casts.
 */
export type AccountErasureDeliveryFenceDatabase = {
  transaction<Result>(
    work: (connection: AccountErasureDeliveryFenceConnection) => Promise<Result>,
  ): Promise<Result>;
};

/**
 * Canonical account-erasure delivery fence used by raw consumers.
 *
 * Lock keys match activation / `fitness.lock_and_reject_account_erasure_write`
 * (`hashtextextended(user_id::text, 0)`). Consumers take
 * `pg_advisory_xact_lock_shared` so archive and sink holders coexist; activation
 * and producers remain exclusive (`pg_advisory_xact_lock`) on the same keys.
 * Fence membership uses the active `user_id` / scrubbed `write_fence_hash`
 * EXISTS query from `coordinateAnalyticsDeliveryGroup`.
 *
 * Always opens one transaction so callers can hold the same locks through
 * publication / archive upload and durable completion work.
 */
export async function withAccountErasureDeliveryFence<Result>(
  database: AccountErasureDeliveryFenceDatabase,
  userIds: readonly string[],
  work: (
    fencedUserIds: ReadonlySet<string>,
    connection: AccountErasureDeliveryFenceConnection,
  ) => Promise<Result>,
): Promise<Result> {
  const users = [...new Set(userIds.map((id) => z.guid().parse(id).toLowerCase()))].sort();
  return database.transaction(async (transaction) => {
    for (const userId of users) {
      await transaction.execute(
        sql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${userId}::text, 0))`,
      );
    }
    const fenced = users.length
      ? await executeWithSchema(
          transaction,
          z.object({ user_id: z.guid() }),
          sql`SELECT candidate.user_id FROM unnest(ARRAY[${sql.join(
            users.map((userId) => sql`${userId}::uuid`),
            sql`, `,
          )}]) AS candidate(user_id)
          WHERE EXISTS (
            SELECT 1 FROM fitness.account_erasure_request AS request
            WHERE (request.user_id = candidate.user_id AND request.status <> 'completed')
              OR request.write_fence_hash = encode(
                public.digest(candidate.user_id::text, 'sha256'),
                'hex'
              )
          )`,
        )
      : [];
    return work(new Set(fenced.map((row) => row.user_id.toLowerCase())), transaction);
  });
}
