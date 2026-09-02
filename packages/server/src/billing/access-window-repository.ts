import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema, timestampStringSchema } from "../lib/typed-sql.ts";
import {
  type AccessWindow,
  resolveAccessWindow,
  toAppStoreSubscriptionState,
} from "./entitlement.ts";

const accessWindowRowSchema = z.object({
  created_at: timestampStringSchema,
  paid_grant_reason: z.string().nullable(),
  stripe_subscription_status: z.string().nullable(),
  app_store_product_id: z.string().nullable(),
  app_store_subscription_status: z.string().nullable(),
  app_store_expires_at: timestampStringSchema.nullable(),
  app_store_revocation_at: timestampStringSchema.nullable(),
});

export async function getAccessWindowForUser(
  db: Pick<Database, "execute">,
  userId: string,
  timezone: string,
): Promise<AccessWindow> {
  const rows = await executeWithSchema(
    db,
    accessWindowRowSchema,
    sql`SELECT
          up.created_at::text AS created_at,
          ub.paid_grant_reason,
          ub.stripe_subscription_status,
          ub.app_store_product_id,
          ub.app_store_subscription_status,
          ub.app_store_expires_at::text AS app_store_expires_at,
          ub.app_store_revocation_at::text AS app_store_revocation_at
        FROM fitness.user_profile up
        LEFT JOIN fitness.user_billing ub ON ub.user_id = up.id
        WHERE up.id = ${userId}
        LIMIT 1`,
  );
  const row = rows[0];
  if (!row) throw new Error("Authenticated user profile not found");
  const appStoreSubscription = toAppStoreSubscriptionState({
    productId: row.app_store_product_id,
    status: row.app_store_subscription_status,
    expiresAt: row.app_store_expires_at,
    revokedAt: row.app_store_revocation_at,
  });
  return resolveAccessWindow({
    userCreatedAt: row.created_at,
    timezone,
    paidGrantReason: row.paid_grant_reason,
    stripeSubscriptionStatus: row.stripe_subscription_status,
    appStoreSubscription,
  });
}
