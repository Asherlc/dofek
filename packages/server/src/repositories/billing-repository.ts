import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type {
  AppStoreNotificationUpdate,
  AppStoreSubscriptionUpdate,
} from "../billing/app-store-subscription.ts";
import { executeWithSchema, timestampStringSchema } from "../lib/typed-sql.ts";

type BillingDatabase = Pick<Database, "execute">;

export const billingRowSchema = z.object({
  user_id: z.string(),
  stripe_customer_id: z.string().nullable(),
  stripe_subscription_id: z.string().nullable(),
  stripe_subscription_status: z.string().nullable(),
  stripe_current_period_end: timestampStringSchema.nullable(),
  stripe_subscription_event_id: z.string().nullable(),
  stripe_subscription_event_created: z.coerce.number().nullable(),
  paid_grant_reason: z.string().nullable(),
  created_at: timestampStringSchema,
  updated_at: timestampStringSchema,
});

export type BillingRow = z.infer<typeof billingRowSchema>;

const billingCustomerProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().nullable(),
  created_at: timestampStringSchema,
  paid_grant_reason: z.string().nullable(),
  stripe_subscription_status: z.string().nullable(),
  stripe_customer_id: z.string().nullable(),
});
const updatedBillingUserSchema = z.object({ user_id: z.string() });
const appStoreAccountTokenSchema = z.object({ app_store_account_token: z.uuid() });
const recordedAppStoreNotificationSchema = z.object({ notification_uuid: z.uuid() });

export type BillingCustomerProfile = z.infer<typeof billingCustomerProfileSchema>;

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
            stripe_subscription_event_id,
            stripe_subscription_event_created,
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

  async findCustomerProfileByUserId(userId: string): Promise<BillingCustomerProfile | null> {
    const rows = await executeWithSchema(
      this.#db,
      billingCustomerProfileSchema,
      sql`SELECT
            profile.id,
            profile.name,
            profile.email,
            profile.created_at::text AS created_at,
            billing.paid_grant_reason,
            billing.stripe_subscription_status,
            billing.stripe_customer_id
          FROM fitness.user_profile profile
          LEFT JOIN fitness.user_billing billing ON billing.user_id = profile.id
          WHERE profile.id = ${userId}
          LIMIT 1`,
    );
    return rows[0] ?? null;
  }

  async upsertStripeCustomerId(userId: string, stripeCustomerId: string): Promise<void> {
    await this.#db.execute(
      sql`INSERT INTO fitness.user_billing (user_id, stripe_customer_id)
          VALUES (${userId}, ${stripeCustomerId})
          ON CONFLICT (user_id) DO UPDATE SET
            stripe_customer_id = EXCLUDED.stripe_customer_id,
            updated_at = now()`,
    );
  }

  async getOrCreateAppStoreAccountToken(userId: string): Promise<string> {
    const rows = await executeWithSchema(
      this.#db,
      appStoreAccountTokenSchema,
      sql`INSERT INTO fitness.user_billing AS billing (user_id, app_store_account_token)
          VALUES (${userId}, gen_random_uuid())
          ON CONFLICT (user_id) DO UPDATE SET
            app_store_account_token = COALESCE(
              billing.app_store_account_token,
              EXCLUDED.app_store_account_token
            ),
            updated_at = CASE
              WHEN billing.app_store_account_token IS NULL THEN now()
              ELSE billing.updated_at
            END
          RETURNING app_store_account_token::text AS app_store_account_token`,
    );
    const row = rows[0];
    if (!row) throw new Error(`Failed to create App Store account token for user ${userId}`);
    return row.app_store_account_token;
  }

  async updateSubscriptionForStripeCustomer(input: {
    stripeEventId: string;
    stripeEventCreated: number;
    stripeCustomerId: string;
    stripeSubscriptionId: string;
    stripeSubscriptionStatus: string;
    stripeCurrentPeriodEnd: Date | null;
  }): Promise<string[]> {
    const rows = await executeWithSchema(
      this.#db,
      updatedBillingUserSchema,
      sql`WITH recorded_event AS (
            INSERT INTO fitness.stripe_webhook_event (event_id, event_created)
            VALUES (${input.stripeEventId}, ${input.stripeEventCreated})
            ON CONFLICT (event_id) DO NOTHING
            RETURNING event_id
          )
          UPDATE fitness.user_billing
          SET stripe_subscription_id = ${input.stripeSubscriptionId},
              stripe_subscription_status = ${input.stripeSubscriptionStatus},
              stripe_current_period_end = ${input.stripeCurrentPeriodEnd},
              stripe_subscription_event_id = ${input.stripeEventId},
              stripe_subscription_event_created = ${input.stripeEventCreated},
              updated_at = now()
          WHERE stripe_customer_id = ${input.stripeCustomerId}
            AND EXISTS (SELECT 1 FROM recorded_event)
            AND (
              stripe_subscription_event_created IS NULL
              OR stripe_subscription_event_created < ${input.stripeEventCreated}
            )
          RETURNING user_id`,
    );
    return rows.map((row) => row.user_id);
  }

  async applyAppStoreSubscription(input: AppStoreSubscriptionUpdate): Promise<string[]> {
    const rows = await executeWithSchema(
      this.#db,
      updatedBillingUserSchema,
      sql`UPDATE fitness.user_billing
          SET app_store_original_transaction_id = ${input.originalTransactionId},
              app_store_transaction_id = ${input.transactionId},
              app_store_product_id = ${input.productId},
              app_store_subscription_status = ${input.status},
              app_store_expires_at = ${input.expiresAt},
              app_store_revocation_at = ${input.revokedAt},
              app_store_environment = ${input.environment},
              updated_at = now()
          WHERE app_store_account_token = ${input.accountToken}::uuid
            AND NOT EXISTS (
              SELECT 1
              FROM fitness.user_billing existing_subscription
              WHERE existing_subscription.app_store_original_transaction_id = ${input.originalTransactionId}
                AND existing_subscription.app_store_account_token <> ${input.accountToken}::uuid
            )
            AND (
              app_store_expires_at IS NULL
              OR ${input.status} = 'revoked'
              OR ${input.expiresAt} > app_store_expires_at
              OR (
                ${input.expiresAt} = app_store_expires_at
                AND app_store_subscription_status <> 'revoked'
                AND ${input.status} <> 'active'
              )
            )
          RETURNING user_id`,
    );
    return rows.map((row) => row.user_id);
  }

  async findUserIdByAppStoreAccountToken(accountToken: string): Promise<string | null> {
    const rows = await executeWithSchema(
      this.#db,
      updatedBillingUserSchema,
      sql`SELECT user_id
            FROM fitness.user_billing
            WHERE app_store_account_token = ${accountToken}::uuid
            LIMIT 1`,
    );
    return rows[0]?.user_id ?? null;
  }
}

export async function applyAppStoreNotification(
  db: Pick<Database, "transaction">,
  input: AppStoreNotificationUpdate,
): Promise<string[]> {
  return db.transaction(async (transaction) => {
    const repository = new BillingRepository(transaction);
    const updatedUserIds = input.subscription
      ? await repository.applyAppStoreSubscription(input.subscription)
      : [];
    const recorded = await executeWithSchema(
      transaction,
      recordedAppStoreNotificationSchema,
      sql`INSERT INTO fitness.app_store_notification (notification_uuid, signed_date)
          VALUES (${input.notificationUuid}::uuid, ${input.signedDate})
          ON CONFLICT (notification_uuid) DO NOTHING
          RETURNING notification_uuid::text AS notification_uuid`,
    );
    if (recorded.length > 0 || !input.subscription || updatedUserIds.length > 0) {
      return updatedUserIds;
    }

    const userId = await repository.findUserIdByAppStoreAccountToken(input.subscription.accountToken);
    return userId ? [userId] : [];
  });
}
