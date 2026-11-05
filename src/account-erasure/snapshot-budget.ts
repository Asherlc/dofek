import { sql } from "drizzle-orm";
import { z } from "zod";
import type { TransactionDatabase } from "../db/index.ts";
import { executeWithSchema } from "../db/typed-sql.ts";

export const ACCOUNT_ERASURE_SNAPSHOT_LIMITS = {
  arrayEntries: 128,
  localItemBytes: 4 * 1024,
  localListBytes: 64 * 1024,
  plaintextBytes: 1024 * 1024,
  encryptedBytes: 2 * 1024 * 1024,
  credentialItemBytes: 64 * 1024,
  credentialBytes: 512 * 1024,
} as const;

export function snapshotBudgetMessage(detail: string): string {
  return `Account deletion snapshot exceeds its ${detail} limit. Contact support before retrying.`;
}

export class AccountErasureSnapshotBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountErasureSnapshotBudgetError";
  }
}

export function assertAccountErasureSnapshotEncryptedBytes(bytes: number): void {
  if (bytes > ACCOUNT_ERASURE_SNAPSHOT_LIMITS.encryptedBytes) {
    throw new AccountErasureSnapshotBudgetError(snapshotBudgetMessage("2 MiB encrypted size"));
  }
}

const sourceBudgetRowSchema = z.object({
  row_counts: z.array(z.coerce.number().int().nonnegative()),
  local_item_bytes: z.coerce.number().int().nonnegative(),
  local_list_bytes: z.coerce.number().int().nonnegative(),
  credential_item_bytes: z.coerce.number().int().nonnegative(),
  credential_bytes: z.coerce.number().int().nonnegative(),
  source_bytes: z.coerce.number().int().nonnegative(),
});

/** Activation holds the user-work/write barrier until capture and request creation commit. */
export async function assertAccountErasureSnapshotSourceBudget(
  transaction: TransactionDatabase,
  userId: string,
): Promise<void> {
  const rowLimit = ACCOUNT_ERASURE_SNAPSHOT_LIMITS.arrayEntries + 1;
  const localItemLimit = ACCOUNT_ERASURE_SNAPSHOT_LIMITS.localItemBytes;
  const [budget] = await executeWithSchema(
    transaction,
    sourceBudgetRowSchema,
    sql`
    WITH connections AS MATERIALIZED (
      SELECT provider_id FROM fitness.provider_connection
      WHERE user_id=${userId}::uuid ORDER BY provider_id LIMIT ${rowLimit}
    ), identities AS MATERIALIZED (
      SELECT auth_provider,provider_account_id,email,revocation_client_id,
        revocation_access_token,revocation_refresh_token
      FROM fitness.auth_account WHERE user_id=${userId}::uuid
      ORDER BY auth_provider,provider_account_id LIMIT ${rowLimit}
    ), authorizations AS MATERIALIZED (
      SELECT token.provider_id,token.access_token,token.refresh_token,token.provider_account_id,
        token.provider_account_lookup_id,token.scopes
      FROM fitness.oauth_token AS token
      JOIN connections ON connections.provider_id=token.provider_id
      WHERE token.user_id=${userId}::uuid
    ), webhooks AS MATERIALIZED (
      SELECT DISTINCT provider_id,subscription_external_id FROM fitness.webhook_subscription
      WHERE user_id=${userId}::uuid AND provider_id IS NOT NULL AND subscription_external_id IS NOT NULL
      ORDER BY provider_id,subscription_external_id LIMIT ${rowLimit}
    ), effects AS MATERIALIZED (
      SELECT system,resource_type,external_id,contact_email FROM fitness.user_external_effect
      WHERE user_id=${userId}::uuid ORDER BY system,resource_type,external_id LIMIT ${rowLimit}
    ), emails AS MATERIALIZED (
      SELECT email FROM (
        SELECT email FROM fitness.user_profile WHERE id=${userId}::uuid
        UNION SELECT email FROM identities
        UNION SELECT email FROM fitness.user_password_credential WHERE user_id=${userId}::uuid
      ) AS candidate WHERE email IS NOT NULL ORDER BY email LIMIT ${rowLimit}
    ), uploads AS MATERIALIZED (
      SELECT id,object_key,import_job_id,r2_multipart_upload_id FROM fitness.file_upload
      WHERE user_id=${userId}::uuid ORDER BY id LIMIT ${rowLimit}
    ), exports AS MATERIALIZED (
      SELECT id,object_key FROM fitness.data_export
      WHERE user_id=${userId}::uuid ORDER BY id LIMIT ${rowLimit}
    ), sessions AS MATERIALIZED (
      SELECT id FROM fitness.session WHERE user_id=${userId}::uuid ORDER BY id LIMIT ${rowLimit}
    ), billing AS MATERIALIZED (
      SELECT stripe_customer_id,stripe_subscription_id FROM fitness.user_billing
      WHERE user_id=${userId}::uuid LIMIT 1
    ), upload_lengths AS (
      SELECT CASE WHEN 36::bigint+coalesce(octet_length(object_key),0)
          +coalesce(octet_length(import_job_id),0)+coalesce(octet_length(r2_multipart_upload_id),0)>${localItemLimit}
        THEN ${localItemLimit}+1
        ELSE octet_length(jsonb_build_object('importJobId',import_job_id,
          'multipartUploadId',r2_multipart_upload_id,'objectKey',object_key,'uploadId',id)::text)-7
      END AS bytes FROM uploads
    ), export_lengths AS (
      SELECT CASE WHEN 36::bigint+coalesce(octet_length(object_key),0)>${localItemLimit}
        THEN ${localItemLimit}+1
        ELSE octet_length(jsonb_build_object('exportId',id,'objectKey',object_key)::text)-3
      END AS bytes FROM exports
    ), session_lengths AS (
      SELECT CASE WHEN octet_length(id)>${localItemLimit} THEN ${localItemLimit}+1
        ELSE octet_length(to_jsonb(id)::text) END AS bytes FROM sessions
    ), local_lengths AS (
      SELECT bytes FROM upload_lengths UNION ALL SELECT bytes FROM export_lengths
      UNION ALL SELECT bytes FROM session_lengths
    ), credentials AS (
      SELECT octet_length(access_token) AS bytes FROM authorizations
      UNION ALL SELECT octet_length(refresh_token) FROM authorizations
      UNION ALL SELECT octet_length(provider_account_id) FROM authorizations
      UNION ALL SELECT octet_length(revocation_access_token) FROM identities WHERE auth_provider='apple'
      UNION ALL SELECT octet_length(revocation_refresh_token) FROM identities WHERE auth_provider='apple'
    ), metadata AS (
      SELECT octet_length(provider_id)::bigint AS bytes FROM connections
      UNION ALL SELECT octet_length(auth_provider)::bigint+octet_length(provider_account_id)
        +coalesce(octet_length(email),0)+coalesce(octet_length(revocation_client_id),0) FROM identities
      UNION ALL SELECT octet_length(provider_id)::bigint+coalesce(octet_length(provider_account_lookup_id),0)
        +coalesce(octet_length(scopes),0) FROM authorizations
      UNION ALL SELECT octet_length(provider_id)::bigint+octet_length(subscription_external_id) FROM webhooks
      UNION ALL SELECT octet_length(system)::bigint+octet_length(resource_type)+octet_length(external_id)
        +coalesce(octet_length(contact_email),0) FROM effects
      UNION ALL SELECT octet_length(email)::bigint FROM emails
      UNION ALL SELECT coalesce(octet_length(stripe_customer_id),0)::bigint
        +coalesce(octet_length(stripe_subscription_id),0) FROM billing
    )
    SELECT ARRAY[
      (SELECT count(*) FROM connections),(SELECT count(*) FROM identities),
      (SELECT count(*) FROM webhooks),(SELECT count(*) FROM effects),(SELECT count(*) FROM emails),
      (SELECT count(*) FROM uploads),(SELECT count(*) FROM exports),(SELECT count(*) FROM sessions)
    ] AS row_counts,
    (SELECT coalesce(max(bytes),0) FROM local_lengths) AS local_item_bytes,
    (SELECT coalesce(sum(bytes),0)+greatest(count(*)-1,0)+2 FROM upload_lengths)
      +(SELECT coalesce(sum(bytes),0)+greatest(count(*)-1,0)+2 FROM export_lengths)
      +(SELECT coalesce(sum(bytes),0)+greatest(count(*)-1,0)+2 FROM session_lengths) AS local_list_bytes,
    (SELECT coalesce(max(bytes),0) FROM credentials) AS credential_item_bytes,
    (SELECT coalesce(sum(bytes),0) FROM credentials) AS credential_bytes,
    (SELECT coalesce(sum(bytes),0) FROM metadata)
      +(SELECT coalesce(sum(bytes),0) FROM credentials)
      +(SELECT coalesce(sum(bytes),0) FROM local_lengths) AS source_bytes
  `,
  );
  if (!budget) throw new Error("Account deletion snapshot source budget was not returned");
  const fail = (detail: string): never => {
    throw new AccountErasureSnapshotBudgetError(snapshotBudgetMessage(detail));
  };
  if (budget.row_counts.some((count) => count > ACCOUNT_ERASURE_SNAPSHOT_LIMITS.arrayEntries)) {
    fail("128-entry retained-list");
  }
  if (budget.local_item_bytes > ACCOUNT_ERASURE_SNAPSHOT_LIMITS.localItemBytes)
    fail("4 KiB local item");
  if (budget.local_list_bytes > ACCOUNT_ERASURE_SNAPSHOT_LIMITS.localListBytes)
    fail("64 KiB combined local-list");
  if (budget.credential_item_bytes > ACCOUNT_ERASURE_SNAPSHOT_LIMITS.credentialItemBytes)
    fail("64 KiB encrypted credential item");
  if (budget.credential_bytes > ACCOUNT_ERASURE_SNAPSHOT_LIMITS.credentialBytes)
    fail("512 KiB encrypted credential input");
  if (budget.source_bytes > ACCOUNT_ERASURE_SNAPSHOT_LIMITS.plaintextBytes)
    fail("1 MiB source payload");
}
