import { sql } from "drizzle-orm";
import { z } from "zod";
import { resolveAccessWindow } from "../billing/entitlement.ts";
import { executeWithSchema, timestampStringSchema } from "../lib/typed-sql.ts";
import { protectedProcedure, router } from "../trpc.ts";

const billingStatusRowSchema = z.object({
  id: z.string(),
  created_at: timestampStringSchema,
  paid_grant_reason: z.string().nullable(),
  stripe_subscription_status: z.string().nullable(),
  stripe_customer_id: z.string().nullable(),
});

export const billingRouter = router({
  status: protectedProcedure.query(async ({ ctx }) => {
    const rows = await executeWithSchema(
      ctx.db,
      billingStatusRowSchema,
      sql`SELECT
            profile.id,
            profile.created_at::text AS created_at,
            billing.paid_grant_reason,
            billing.stripe_subscription_status,
            billing.stripe_customer_id
          FROM fitness.user_profile profile
          LEFT JOIN fitness.user_billing billing ON billing.user_id = profile.id
          WHERE profile.id = ${ctx.userId}
          LIMIT 1`,
    );
    const row = rows[0];
    if (!row) {
      throw new Error(`Authenticated user ${ctx.userId} does not exist`);
    }

    const access = resolveAccessWindow({
      userCreatedAt: row.created_at,
      paidGrantReason: row.paid_grant_reason,
      stripeSubscriptionStatus: row.stripe_subscription_status,
    });

    return {
      hasFullAccess: access.kind === "full",
      access,
      stripeSubscriptionStatus: row.stripe_subscription_status,
      canManageBilling: row.stripe_customer_id !== null,
    };
  }),
});
