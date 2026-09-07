import { sql } from "drizzle-orm";
import { z } from "zod";
import type { TransactionDatabase } from "../db/index.ts";
import { loadTokens } from "../db/tokens.ts";
import { executeWithSchema } from "../db/typed-sql.ts";
import { listUserExternalEffects } from "../db/user-external-effect.ts";
import { getAllProviders } from "../providers/index.ts";
import type { Provider } from "../providers/types.ts";
import {
  decryptCredentialValue,
  encryptCredentialValue,
} from "../security/credential-encryption.ts";

const providerConnectionRowSchema = z.object({ provider_id: z.string().min(1) });
const webhookRowSchema = z.object({
  provider_id: z.string().min(1),
  subscription_external_id: z.string().min(1),
});
const billingRowSchema = z.object({
  stripe_customer_id: z.string().nullable(),
  stripe_subscription_id: z.string().nullable(),
});
const identityCredentialRowSchema = z.object({
  auth_provider: z.string().min(1),
  provider_account_id: z.string().min(1),
  revocation_access_token: z.string().min(1),
  revocation_client_id: z.string().min(1),
  revocation_refresh_token: z.string().min(1).nullable(),
});
const processorEmailRowSchema = z.object({ email: z.string().email() });
const idRowSchema = z.object({ id: z.uuid() });
const fileUploadRowSchema = z.object({
  id: z.uuid(),
  import_job_id: z.string().nullable(),
  object_key: z.string().min(1),
  r2_multipart_upload_id: z.string().min(1).nullable(),
});
const dataExportRowSchema = z.object({
  id: z.uuid(),
  object_key: z.string().min(1).nullable(),
});
const appleAccountCountRowSchema = z.object({
  credential_count: z.coerce.number().int().nonnegative(),
  total_count: z.coerce.number().int().nonnegative(),
});
const authIdentitySnapshotRowSchema = z.object({
  auth_provider: z.string().min(1),
  email: z.string().email().nullable(),
  provider_account_id: z.string().min(1),
});
const sessionIdRowSchema = z.object({ id: z.string().min(1) });

export class AppleRevocationCredentialMissingError extends Error {
  constructor() {
    super(
      "Sign in with Apple again before deleting your account so Dofek can revoke the existing Apple authorization.",
    );
    this.name = "AppleRevocationCredentialMissingError";
  }
}

export class ProviderRevocationPrerequisiteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderRevocationPrerequisiteError";
  }
}

export const accountErasureRemoteSnapshotSchema = z.object({
  authIdentities: z.array(
    z.object({
      authProvider: z.string().min(1),
      email: z.string().email().nullable(),
      providerAccountId: z.string().min(1),
    }),
  ),
  appleCredentials: z.array(
    z.object({
      accessToken: z.string().min(1),
      clientId: z.string().min(1),
      providerAccountId: z.string().min(1),
      refreshToken: z.string().min(1).nullable(),
    }),
  ),
  externalEffects: z.array(
    z.discriminatedUnion("system", [
      z.object({
        contactEmail: z.null(),
        externalId: z.string().min(1),
        resourceType: z.literal("customer"),
        system: z.literal("stripe"),
      }),
      z.object({
        contactEmail: z.string().email(),
        externalId: z.string().min(1),
        resourceType: z.literal("ticket"),
        system: z.literal("zoho_desk"),
      }),
    ]),
  ),
  processorEmails: z.array(z.string().email()),
  posthogDistinctId: z.string().trim().min(1).max(200),
  localIdentifiers: z.object({
    activityIds: z.array(z.uuid()),
    exportObjects: z.array(
      z.object({
        exportId: z.uuid(),
        objectKey: z.string().min(1).nullable(),
      }),
    ),
    fileUploads: z.array(
      z.object({
        importJobId: z.string().nullable(),
        multipartUploadId: z.string().min(1).nullable(),
        objectKey: z.string().min(1),
        uploadId: z.uuid(),
      }),
    ),
    processingOperationIds: z.array(z.uuid()),
    sessionIds: z.array(z.string().min(1)),
    sleepSessionIds: z.array(z.uuid()),
    userId: z.uuid(),
  }),
  providerConnections: z.array(
    z.discriminatedUnion("disposition", [
      z.object({
        disposition: z.literal("no_remote_authorization"),
        providerId: z.string().min(1),
      }),
      z.object({
        accessToken: z.string().min(1),
        disposition: z.literal("revocation_credentials"),
        expiresAt: z.iso.datetime(),
        providerAccountId: z.string().min(1).optional(),
        providerId: z.string().min(1),
        refreshToken: z.string().min(1).nullable(),
        scopes: z.string().nullable(),
      }),
    ]),
  ),
  stripe: z
    .object({
      customerId: z.string().min(1).nullable(),
      subscriptionId: z.string().min(1).nullable(),
    })
    .nullable(),
  webhooks: z.array(
    z.object({
      providerId: z.string().min(1),
      subscriptionExternalId: z.string().min(1),
    }),
  ),
});

export type AccountErasureRemoteSnapshot = z.infer<typeof accountErasureRemoteSnapshotSchema>;

function snapshotEncryptionContext(userId: string) {
  return {
    tableName: "fitness.account_erasure_request",
    columnName: "encrypted_remote_snapshot",
    scopeId: userId,
  };
}

async function loadProviderConnections(
  database: TransactionDatabase,
  userId: string,
  providers: readonly Provider[],
): Promise<AccountErasureRemoteSnapshot["providerConnections"]> {
  const providersById = new Map(providers.map((provider) => [provider.id, provider]));
  const connections = await executeWithSchema(
    database,
    providerConnectionRowSchema,
    sql`SELECT provider_id
        FROM fitness.provider_connection
        WHERE user_id = ${userId}::uuid
        ORDER BY provider_id`,
  );
  const snapshots = await Promise.all(
    connections.map(async (connection) => {
      if (connection.provider_id === "coros") {
        throw new ProviderRevocationPrerequisiteError(
          "Disconnect Dofek in the COROS app under Profile > Settings > 3rd Party Apps > Data Sync, then disconnect COROS in Dofek before deleting your account.",
        );
      }
      if (connection.provider_id === "decathlon") {
        throw new ProviderRevocationPrerequisiteError(
          "Manually unlink Dofek from your Decathlon account (contact Decathlon support if no unlink control is available), then disconnect Decathlon in Dofek before deleting your account.",
        );
      }
      const provider = providersById.get(connection.provider_id);
      if (!provider) {
        throw new ProviderRevocationPrerequisiteError(
          `Dofek cannot verify the ${connection.provider_id} connection for account deletion. Contact support before retrying.`,
        );
      }
      const tokens = await loadTokens(database, connection.provider_id, userId);
      if (!tokens) {
        if (typeof provider.authSetup === "function") {
          throw new ProviderRevocationPrerequisiteError(
            `Reconnect ${provider.name}, then disconnect it in Dofek before deleting your account so Dofek can verify the remote authorization is removed.`,
          );
        }
        return {
          disposition: "no_remote_authorization" as const,
          providerId: connection.provider_id,
        };
      }
      if (connection.provider_id === "polar" && tokens.providerAccountId === undefined) {
        throw new ProviderRevocationPrerequisiteError(
          "Reconnect Polar before deleting your account so Dofek can durably revoke the Polar authorization.",
        );
      }
      if (connection.provider_id === "mapmyfitness" && tokens.providerAccountId === undefined) {
        throw new ProviderRevocationPrerequisiteError(
          "Reconnect MapMyFitness before deleting your account so Dofek can durably revoke the MapMyFitness authorization.",
        );
      }
      if (connection.provider_id === "withings" && tokens.providerAccountId === undefined) {
        throw new ProviderRevocationPrerequisiteError(
          "Reconnect Withings before deleting your account so Dofek can identify the remote authorization that must be revoked.",
        );
      }
      if (connection.provider_id === "withings") {
        throw new ProviderRevocationPrerequisiteError(
          "Revoke Dofek's access in Withings, then disconnect Withings in Dofek before deleting your account.",
        );
      }
      if (connection.provider_id === "komoot" && !tokens.refreshToken) {
        throw new ProviderRevocationPrerequisiteError(
          "Reconnect Komoot before deleting your account so Dofek can durably revoke the Komoot authorization.",
        );
      }
      return {
        accessToken: tokens.accessToken,
        disposition: "revocation_credentials" as const,
        expiresAt: tokens.expiresAt.toISOString(),
        ...(tokens.providerAccountId
          ? {
              providerAccountId: tokens.providerAccountId,
            }
          : {}),
        providerId: connection.provider_id,
        refreshToken: tokens.refreshToken,
        scopes: tokens.scopes,
      };
    }),
  );
  return snapshots;
}

async function loadAppleCredentials(
  database: TransactionDatabase,
  userId: string,
): Promise<AccountErasureRemoteSnapshot["appleCredentials"]> {
  const [counts] = await executeWithSchema(
    database,
    appleAccountCountRowSchema,
    sql`SELECT
          count(*)::integer AS total_count,
          count(*) FILTER (
            WHERE revocation_access_token IS NOT NULL
              AND revocation_client_id IS NOT NULL
          )::integer AS credential_count
        FROM fitness.auth_account
        WHERE user_id = ${userId}::uuid
          AND auth_provider = 'apple'`,
  );
  if (!counts || counts.credential_count !== counts.total_count) {
    throw new AppleRevocationCredentialMissingError();
  }
  const rows = await executeWithSchema(
    database,
    identityCredentialRowSchema,
    sql`SELECT
          auth_provider,
          provider_account_id,
          revocation_access_token,
          revocation_refresh_token,
          revocation_client_id
        FROM fitness.auth_account
        WHERE user_id = ${userId}::uuid
          AND auth_provider = 'apple'
          AND revocation_access_token IS NOT NULL
          AND revocation_client_id IS NOT NULL`,
  );
  return Promise.all(
    rows.map(async (row) => {
      const scopeId = `${row.auth_provider}:${row.provider_account_id}`;
      return {
        accessToken: await decryptCredentialValue(row.revocation_access_token, {
          tableName: "fitness.auth_account",
          columnName: "revocation_access_token",
          scopeId,
        }),
        clientId: row.revocation_client_id,
        providerAccountId: row.provider_account_id,
        refreshToken: row.revocation_refresh_token
          ? await decryptCredentialValue(row.revocation_refresh_token, {
              tableName: "fitness.auth_account",
              columnName: "revocation_refresh_token",
              scopeId,
            })
          : null,
      };
    }),
  );
}

export async function createEncryptedAccountErasureSnapshot(
  database: TransactionDatabase,
  userId: string,
  providers: readonly Provider[] = getAllProviders(),
): Promise<string> {
  const [
    providerConnections,
    webhooks,
    billingRows,
    appleCredentials,
    processorEmailRows,
    activityRows,
    sleepSessionRows,
    processingOperationRows,
    fileUploadRows,
    dataExportRows,
    externalEffects,
    authIdentityRows,
    sessionRows,
  ] = await Promise.all([
    loadProviderConnections(database, userId, providers),
    executeWithSchema(
      database,
      webhookRowSchema,
      sql`SELECT DISTINCT provider_id, subscription_external_id
            FROM fitness.webhook_subscription
            WHERE user_id = ${userId}::uuid
              AND provider_id IS NOT NULL
              AND subscription_external_id IS NOT NULL
            ORDER BY provider_id, subscription_external_id`,
    ),
    executeWithSchema(
      database,
      billingRowSchema,
      sql`SELECT stripe_customer_id, stripe_subscription_id
            FROM fitness.user_billing
            WHERE user_id = ${userId}::uuid
            LIMIT 1`,
    ),
    loadAppleCredentials(database, userId),
    executeWithSchema(
      database,
      processorEmailRowSchema,
      sql`SELECT email
            FROM (
              SELECT email
              FROM fitness.user_profile
              WHERE id = ${userId}::uuid
              UNION
              SELECT email
              FROM fitness.auth_account
              WHERE user_id = ${userId}::uuid
              UNION
              SELECT email
              FROM fitness.user_password_credential
              WHERE user_id = ${userId}::uuid
            ) AS processor_email
            WHERE email IS NOT NULL
            ORDER BY email`,
    ),
    executeWithSchema(
      database,
      idRowSchema,
      sql`SELECT id FROM fitness.activity WHERE user_id = ${userId}::uuid ORDER BY id`,
    ),
    executeWithSchema(
      database,
      idRowSchema,
      sql`SELECT id FROM fitness.sleep_session WHERE user_id = ${userId}::uuid ORDER BY id`,
    ),
    executeWithSchema(
      database,
      idRowSchema,
      sql`SELECT id
            FROM fitness.processing_operation
            WHERE user_id = ${userId}::uuid
            ORDER BY id`,
    ),
    executeWithSchema(
      database,
      fileUploadRowSchema,
      sql`SELECT
              id,
              object_key,
              import_job_id,
              r2_multipart_upload_id
            FROM fitness.file_upload
            WHERE user_id = ${userId}::uuid
            ORDER BY id`,
    ),
    executeWithSchema(
      database,
      dataExportRowSchema,
      sql`SELECT id, object_key
            FROM fitness.data_export
            WHERE user_id = ${userId}::uuid
            ORDER BY id`,
    ),
    listUserExternalEffects(database, userId),
    executeWithSchema(
      database,
      authIdentitySnapshotRowSchema,
      sql`SELECT auth_provider, provider_account_id, email
            FROM fitness.auth_account
            WHERE user_id = ${userId}::uuid
            ORDER BY auth_provider, provider_account_id`,
    ),
    executeWithSchema(
      database,
      sessionIdRowSchema,
      sql`SELECT id
            FROM fitness.session
            WHERE user_id = ${userId}::uuid
            ORDER BY id`,
    ),
  ]);

  const billing = billingRows[0];
  const snapshot = accountErasureRemoteSnapshotSchema.parse({
    appleCredentials,
    authIdentities: authIdentityRows.map((row) => ({
      authProvider: row.auth_provider,
      email: row.email,
      providerAccountId: row.provider_account_id,
    })),
    externalEffects,
    localIdentifiers: {
      activityIds: activityRows.map((row) => row.id),
      exportObjects: dataExportRows.map((row) => ({
        exportId: row.id,
        objectKey: row.object_key,
      })),
      fileUploads: fileUploadRows.map((row) => ({
        importJobId: row.import_job_id,
        multipartUploadId: row.r2_multipart_upload_id,
        objectKey: row.object_key,
        uploadId: row.id,
      })),
      processingOperationIds: processingOperationRows.map((row) => row.id),
      sessionIds: sessionRows.map((row) => row.id),
      sleepSessionIds: sleepSessionRows.map((row) => row.id),
      userId,
    },
    processorEmails: processorEmailRows.map((row) => row.email),
    posthogDistinctId: userId,
    providerConnections,
    stripe: billing
      ? {
          customerId: billing.stripe_customer_id,
          subscriptionId: billing.stripe_subscription_id,
        }
      : null,
    webhooks: webhooks.map((webhook) => ({
      providerId: webhook.provider_id,
      subscriptionExternalId: webhook.subscription_external_id,
    })),
  });
  return encryptCredentialValue(JSON.stringify(snapshot), snapshotEncryptionContext(userId));
}

export async function decryptAccountErasureSnapshot(
  encryptedSnapshot: string,
  userId: string,
): Promise<AccountErasureRemoteSnapshot> {
  const plaintext = await decryptCredentialValue(
    encryptedSnapshot,
    snapshotEncryptionContext(userId),
  );
  return accountErasureRemoteSnapshotSchema.parse(JSON.parse(plaintext));
}
