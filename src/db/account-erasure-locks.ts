import { sql } from "drizzle-orm";
import type { TransactionDatabase } from "./index.ts";

const queuedUserWorkLockPrefix = "account-erasure-queued-user-work:";

export function accountErasureQueuedUserWorkLockName(userId: string): string {
  return `${queuedUserWorkLockPrefix}${userId}`;
}

export async function lockAccountErasureActivation(
  transaction: TransactionDatabase,
  userId: string,
): Promise<void> {
  // Drain jobs before taking the existing user-write lock. Reversing this order
  // can deadlock a pre-fence job that already holds the shared work lock and is
  // about to enter a fenced database write.
  await transaction.execute(
    sql`SELECT pg_advisory_xact_lock(
          hashtextextended(${accountErasureQueuedUserWorkLockName(userId)}::text, 0)
        )`,
  );
  await transaction.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${userId}::text, 0))`,
  );
}
