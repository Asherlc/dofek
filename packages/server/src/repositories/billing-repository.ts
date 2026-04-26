import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema, timestampStringSchema } from "../lib/typed-sql.ts";

type BillingDatabase = Pick<Database, "execute">;

export const billingRowSchema = z.object({
  user_id: z.string(),
  stripe_customer_id: z.string().nullable(),
  stripe_subscription_id: z.string().nullable(),
  stripe_subscription_status: z.string().nullable(),
  stripe_current_period_end: timestampStringSchema.nullable(),
  paid_grant_reason: z.string().nullable(),
  created_at: timestampStringSchema,
  updated_at: timestampStringSchema,
});

export type BillingRow = z.infer<typeof billingRowSchema>;

export class BillingRepository {
  readonly #db: BillingDatabase;

  constructor(db: BillingDatabase) {
    this.#db = db;
  }

  async findByUserId(userId: string): Promise<BillingRow | null> {
    const rows = await executeWithSchema(
      this.#db,
      billingRowSchema,
      sql`SELECT
            user_id,
            stripe_customer_id,
            stripe_subscription_id,
            stripe_subscription_status,
            stripe_current_period_end::text AS stripe_current_period_end,
            paid_grant_reason,
            created_at::text AS created_at,
            updated_at::text AS updated_at
          FROM fitness.user_billing
          WHERE user_id = ${userId}
          LIMIT 1`,
    );
    return rows[0] ?? null;
  }

  async upsertPaidGrant(userId: string, reason: string): Promise<void> {
    await this.#db.execute(
      sql`INSERT INTO fitness.user_billing (user_id, paid_grant_reason)
          VALUES (${userId}, ${reason})
          ON CONFLICT (user_id) DO UPDATE SET
            paid_grant_reason = EXCLUDED.paid_grant_reason,
            updated_at = now()`,
    );
  }
}
