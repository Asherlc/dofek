import { sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/index.ts";
import { executeWithSchema } from "../db/typed-sql.ts";
import { eraseStripeAccount } from "./remote-revocation.ts";
import { decryptAccountErasureSnapshot } from "./remote-snapshot.ts";

const acceptedRequestRowSchema = z.object({
  encrypted_remote_snapshot: z.string().min(1),
  status: z.string().min(1),
  stripe_erased: z.boolean(),
  user_id: z.uuid(),
});

type StripeErasureOperation = typeof eraseStripeAccount;

export async function eraseStripeForAcceptedAccountErasure(
  database: Pick<Database, "execute" | "transaction">,
  requestId: string,
  eraseStripe: StripeErasureOperation = eraseStripeAccount,
): Promise<void> {
  const rows = await executeWithSchema(
    database,
    acceptedRequestRowSchema,
    sql`SELECT
          request.encrypted_remote_snapshot,
          request.status,
          request.user_id,
          EXISTS (
            SELECT 1
            FROM fitness.account_erasure_checkpoint AS checkpoint
            WHERE checkpoint.request_id = request.id
              AND checkpoint.phase = 'stripe_erasure'
          ) AS stripe_erased
        FROM fitness.account_erasure_request AS request
        WHERE request.id = ${requestId}::uuid
        LIMIT 1`,
  );
  const request = rows[0];
  if (!request) {
    throw new Error("Accepted account erasure request was not found");
  }
  if (request.status === "completed" || request.stripe_erased) return;

  const snapshot = await decryptAccountErasureSnapshot(
    request.encrypted_remote_snapshot,
    request.user_id,
  );
  await eraseStripe(snapshot);

  await database.transaction(async (transaction) => {
    const lockedRows = await executeWithSchema(
      transaction,
      z.object({
        status: z.string().min(1),
        stripe_erased: z.boolean(),
      }),
      sql`SELECT
            request.status,
            EXISTS (
              SELECT 1
              FROM fitness.account_erasure_checkpoint AS checkpoint
              WHERE checkpoint.request_id = request.id
                AND checkpoint.phase = 'stripe_erasure'
            ) AS stripe_erased
          FROM fitness.account_erasure_request AS request
          WHERE request.id = ${requestId}::uuid
          FOR UPDATE`,
    );
    const lockedRequest = lockedRows[0];
    if (!lockedRequest) {
      throw new Error("Accepted account erasure request disappeared before Stripe checkpointing");
    }
    if (lockedRequest.status === "completed" || lockedRequest.stripe_erased) return;

    await transaction.execute(
      sql`INSERT INTO fitness.account_erasure_checkpoint (
            request_id, phase, details
          )
          VALUES (${requestId}::uuid, 'stripe_erasure', NULL)
          ON CONFLICT (request_id, phase) DO NOTHING`,
    );
  });
}
