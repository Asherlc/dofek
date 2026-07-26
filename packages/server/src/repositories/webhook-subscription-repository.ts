import type { Database } from "dofek/db";
import {
  decryptCredentialValue,
  encryptCredentialValue,
} from "dofek/security/credential-encryption";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema } from "../lib/typed-sql.ts";

const activeSubscriptionRowSchema = z.object({
  id: z.string(),
  provider_id: z.string().nullable(),
  verify_token: z.string(),
  signing_secret: z.string().nullable(),
});

const subscriptionIdRowSchema = z.object({ id: z.string() });

function webhookSecretContext(
  providerName: string,
  columnName: "verify_token" | "signing_secret",
): {
  tableName: string;
  columnName: string;
  scopeId: string;
} {
  return {
    tableName: "fitness.webhook_subscription",
    columnName,
    scopeId: providerName,
  };
}

export interface ActiveWebhookSubscription {
  id: string;
  providerId: string | null;
  verifyToken: string;
  signingSecret: string | null;
}

export interface UpsertWebhookSubscriptionInput {
  userId: string | null;
  providerId: string | null;
  providerName: string;
  subscriptionExternalId: string;
  verifyToken: string;
  signingSecret: string | null;
  expiresAt: Date | null;
  metadata: Record<string, unknown>;
}

export class WebhookSubscriptionRepository {
  readonly #db: Pick<Database, "execute">;

  constructor(db: Pick<Database, "execute">) {
    this.#db = db;
  }

  async *iterateActiveByProviderName(
    providerName: string,
  ): AsyncGenerator<ActiveWebhookSubscription> {
    const rows = await executeWithSchema(
      this.#db,
      activeSubscriptionRowSchema,
      sql`SELECT id, provider_id, verify_token, signing_secret
          FROM fitness.webhook_subscription
          WHERE provider_name = ${providerName} AND status = 'active'
          ORDER BY created_at`,
    );
    for (const row of rows) {
      const verifyToken = await decryptCredentialValue(
        row.verify_token,
        webhookSecretContext(providerName, "verify_token"),
      );
      const signingSecret = row.signing_secret
        ? await decryptCredentialValue(
            row.signing_secret,
            webhookSecretContext(providerName, "signing_secret"),
          )
        : null;

      yield {
        id: row.id,
        providerId: row.provider_id,
        verifyToken,
        signingSecret,
      };
    }
  }

  async hasActiveByProviderName(providerName: string): Promise<boolean> {
    const rows = await executeWithSchema(
      this.#db,
      subscriptionIdRowSchema,
      sql`SELECT id FROM fitness.webhook_subscription
          WHERE provider_name = ${providerName}
            AND user_id IS NULL
            AND status = 'active'
          LIMIT 1`,
    );
    return rows.length > 0;
  }

  async upsertActiveSubscription(input: UpsertWebhookSubscriptionInput): Promise<void> {
    if ((input.userId === null) !== (input.providerId === null)) {
      throw new Error("Webhook subscriptions require both userId and providerId, or neither");
    }

    const encryptedVerifyToken = await encryptCredentialValue(
      input.verifyToken,
      webhookSecretContext(input.providerName, "verify_token"),
    );
    const encryptedSigningSecret = input.signingSecret
      ? await encryptCredentialValue(
          input.signingSecret,
          webhookSecretContext(input.providerName, "signing_secret"),
        )
      : null;

    const commonValues = sql`
      ${input.providerName},
      ${input.subscriptionExternalId},
      ${encryptedVerifyToken},
      ${encryptedSigningSecret},
      'active',
      ${input.expiresAt},
      ${JSON.stringify(input.metadata)}::jsonb
    `;
    const updateValues = sql`
      subscription_external_id = EXCLUDED.subscription_external_id,
      verify_token = EXCLUDED.verify_token,
      signing_secret = EXCLUDED.signing_secret,
      status = 'active',
      expires_at = EXCLUDED.expires_at,
      metadata = EXCLUDED.metadata,
      updated_at = NOW()
    `;

    if (input.userId && input.providerId) {
      await this.#db.execute(
        sql`INSERT INTO fitness.webhook_subscription (
              user_id, provider_id, provider_name, subscription_external_id,
              verify_token, signing_secret, status, expires_at, metadata
            ) VALUES (
              ${input.userId},
              ${input.providerId},
              ${commonValues}
            )
            ON CONFLICT (user_id, provider_id)
            WHERE user_id IS NOT NULL AND provider_id IS NOT NULL AND status = 'active'
            DO UPDATE SET ${updateValues}`,
      );
      return;
    }

    await this.#db.execute(
      sql`INSERT INTO fitness.webhook_subscription (
            provider_name, subscription_external_id, verify_token,
            signing_secret, status, expires_at, metadata
          ) VALUES (${commonValues})
          ON CONFLICT (provider_name)
          WHERE user_id IS NULL AND status = 'active'
          DO UPDATE SET ${updateValues}`,
    );
  }
}
