import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema, timestampStringSchema } from "../lib/typed-sql.ts";
import { type AccessWindow, resolveAccessWindow } from "./entitlement.ts";

const accessWindowRowSchema = z.object({
  created_at: timestampStringSchema,
  paid_grant_reason: z.string().nullable(),
  stripe_subscription_status: z.string().nullable(),
});

export async function getAccessWindowForUser(
  db: Pick<Database, "execute">,
  userId: string,
): Promise<AccessWindow> {
  const rows = await executeWithSchema(
    db,
    accessWindowRowSchema,
    sql`SELECT
          up.created_at::text AS created_at,
          ub.paid_grant_reason,
          ub.stripe_subscription_status
        FROM fitness.user_profile up
        LEFT JOIN fitness.user_billing ub ON ub.user_id = up.id
        WHERE up.id = ${userId}
        LIMIT 1`,
  );
  const row = rows[0];
  if (!row) throw new Error("Authenticated user profile not found");
  return resolveAccessWindow({
    userCreatedAt: row.created_at,
    paidGrantReason: row.paid_grant_reason,
    stripeSubscriptionStatus: row.stripe_subscription_status,
  });
}
