import { sql } from "drizzle-orm";
import { z } from "zod";
import { sendPlainTextEmail } from "../email.ts";
import { providerAuthFailureReasonSchema } from "../providers/auth-errors.ts";
import { withAccountErasureUserWriteFence } from "./account-erasure.ts";
import { executeWithSchema } from "./execute-with-schema.ts";
import type { Database } from "./index.ts";

const notificationRowSchema = z.object({
  email: z.string().email(),
  provider_name: z.string(),
  auth_failure_reason: providerAuthFailureReasonSchema.nullable(),
});

/** Suppress repeated warnings during a connection's ongoing failure streak. */
export async function notifyProviderSyncIssue(
  db: Pick<Database, "transaction">,
  userId: string,
  providerId: string,
): Promise<void> {
  await withAccountErasureUserWriteFence(db, userId, async (transaction) => {
    // Serialize delivery with other notifications and scheduled failure logging.
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${userId}:${providerId}`}, 0))`,
    );
    const [notification] = await executeWithSchema(
      transaction,
      notificationRowSchema,
      sql`SELECT profile.email, provider.name AS provider_name, latest.auth_failure_reason
          FROM fitness.provider_connection connection
          JOIN fitness.user_profile profile ON profile.id = connection.user_id
          JOIN fitness.provider provider ON provider.id = connection.provider_id
          LEFT JOIN fitness.provider_issue_email delivery
            ON delivery.user_id = connection.user_id
            AND delivery.provider_id = connection.provider_id
          CROSS JOIN LATERAL (
            SELECT status, auth_failure_reason, synced_at
            FROM fitness.sync_log
            WHERE user_id = connection.user_id
              AND provider_id = connection.provider_id
              AND data_type = 'sync'
              AND synced_at >= connection.created_at
            ORDER BY synced_at DESC, id DESC
            LIMIT 1
          ) latest
          LEFT JOIN LATERAL (
            SELECT synced_at
            FROM fitness.sync_log
            WHERE user_id = connection.user_id
              AND provider_id = connection.provider_id
              AND data_type = 'sync'
              AND status = 'success'
              AND synced_at >= connection.created_at
            ORDER BY synced_at DESC, id DESC
            LIMIT 1
          ) recovery ON true
          WHERE connection.user_id = ${userId}
            AND connection.provider_id = ${providerId}
            AND profile.email IS NOT NULL
            AND latest.status = 'error'
            AND delivery.sent_at IS NULL
            AND (
              latest.auth_failure_reason IS NOT NULL
              OR (
                SELECT COUNT(*) FROM (
                  SELECT id
                  FROM fitness.sync_log
                  WHERE user_id = connection.user_id
                    AND provider_id = connection.provider_id
                    AND data_type = 'sync'
                    AND status = 'error'
                    AND origin = 'scheduled'
                    AND synced_at >= connection.created_at
                    AND (recovery.synced_at IS NULL OR synced_at > recovery.synced_at)
                  ORDER BY synced_at DESC, id DESC
                  LIMIT 2
                ) failures
              ) = 2
            )
          FOR UPDATE OF connection`,
    );
    if (!notification) return;

    const providerName = notification.provider_name;
    const explanation = notification.auth_failure_reason
      ? `Reconnect ${providerName} in Dofek to resume syncing your health data.`
      : `Dofek has been unable to sync ${providerName} during repeated automatic syncs. We will keep trying automatically. Open the connection in Dofek to check its status or try syncing again.`;
    await sendPlainTextEmail({
      toEmail: notification.email,
      subject: `Your ${providerName} connection needs attention`,
      text: [
        `Your ${providerName} connection needs attention.`,
        "",
        explanation,
        "",
        `Manage your connection: https://dofek.fit/providers/${encodeURIComponent(providerId)}`,
      ].join("\n"),
      signal: AbortSignal.timeout(30_000),
    });
    // Only successful delivery suppresses subsequent alerts; failures can retry on the next sync.
    await transaction.execute(
      sql`INSERT INTO fitness.provider_issue_email (user_id, provider_id, sent_at)
          VALUES (${userId}, ${providerId}, clock_timestamp())
          ON CONFLICT (user_id, provider_id)
          DO UPDATE SET sent_at = EXCLUDED.sent_at`,
    );
  });
}
