import { providerLabel } from "@dofek/providers/providers";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { TokenSet } from "../auth/oauth.ts";
import type { Database, TransactionDatabase } from "../db/index.ts";
import { loadTokens } from "../db/tokens.ts";
import { executeWithSchema } from "../db/typed-sql.ts";
import { listUserExternalEffects } from "../db/user-external-effect.ts";
import { getAllProviders } from "../providers/index.ts";
import { isTheCragPublicProfileScope } from "../providers/thecrag/identity.ts";
import { getProviderAuthTypeFromSetup, type Provider } from "../providers/types.ts";
import {
  decryptCredentialValue,
  encryptCredentialValue,
} from "../security/credential-encryption.ts";

import {
  ACCOUNT_ERASURE_SNAPSHOT_LIMITS,
  AccountErasureSnapshotBudgetError,
  assertAccountErasureSnapshotEncryptedBytes,
  assertAccountErasureSnapshotSourceBudget,
  snapshotBudgetMessage,
} from "./snapshot-budget.ts";

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

export const accountErasureRemoteSnapshotSchema = z
  .object({
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
      sessionIds: z.array(z.string().min(1)),
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
          authorizationId: z.uuid().optional(),
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
  })
  .superRefine((snapshot, context) => {
    for (const [name, value] of Object.entries(snapshot)) {
      if (Array.isArray(value) && value.length > ACCOUNT_ERASURE_SNAPSHOT_LIMITS.arrayEntries) {
        context.addIssue({
          code: "custom",
          path: [name],
          message: snapshotBudgetMessage(
            `${ACCOUNT_ERASURE_SNAPSHOT_LIMITS.arrayEntries}-entry ${name}`,
          ),
        });
        return;
      }
    }
    const credentialValues: Array<string | null | undefined> = snapshot.appleCredentials.flatMap(
      (credential) => [credential.accessToken, credential.refreshToken],
    );
    for (const connection of snapshot.providerConnections) {
      if (connection.disposition === "revocation_credentials") {
        credentialValues.push(
          connection.accessToken,
          connection.refreshToken,
          connection.providerAccountId,
        );
      }
    }
    let credentialBytes = 0;
    for (const value of credentialValues) {
      if (value == null) continue;
      const bytes = Buffer.byteLength(value, "utf8");
      if (bytes > ACCOUNT_ERASURE_SNAPSHOT_LIMITS.credentialItemBytes) {
        context.addIssue({
          code: "custom",
          message: snapshotBudgetMessage("64 KiB decoded credential item"),
        });
        return;
      }
      credentialBytes += bytes;
    }
    if (credentialBytes > ACCOUNT_ERASURE_SNAPSHOT_LIMITS.credentialBytes) {
      context.addIssue({
        code: "custom",
        message: snapshotBudgetMessage("512 KiB decoded credential"),
      });
      return;
    }
    const localLists = {
      exportObjects: snapshot.localIdentifiers.exportObjects,
      fileUploads: snapshot.localIdentifiers.fileUploads,
      sessionIds: snapshot.localIdentifiers.sessionIds,
    };
    let localListBytes = 0;
    for (const [name, entries] of Object.entries(localLists)) {
      if (entries.length > ACCOUNT_ERASURE_SNAPSHOT_LIMITS.arrayEntries) {
        context.addIssue({
          code: "custom",
          path: ["localIdentifiers", name],
          message: snapshotBudgetMessage(
            `${ACCOUNT_ERASURE_SNAPSHOT_LIMITS.arrayEntries}-entry ${name}`,
          ),
        });
        return;
      }
      for (const entry of entries) {
        if (
          Buffer.byteLength(JSON.stringify(entry), "utf8") >
          ACCOUNT_ERASURE_SNAPSHOT_LIMITS.localItemBytes
        ) {
          context.addIssue({
            code: "custom",
            path: ["localIdentifiers", name],
            message: snapshotBudgetMessage(`4 KiB ${name} item`),
          });
          return;
        }
      }
      localListBytes += Buffer.byteLength(JSON.stringify(entries), "utf8");
    }
    if (localListBytes > ACCOUNT_ERASURE_SNAPSHOT_LIMITS.localListBytes) {
      context.addIssue({
        code: "custom",
        path: ["localIdentifiers"],
        message: snapshotBudgetMessage("64 KiB combined local-list"),
      });
      return;
    }
    if (
      Buffer.byteLength(JSON.stringify(snapshot), "utf8") >
      ACCOUNT_ERASURE_SNAPSHOT_LIMITS.plaintextBytes
    ) {
      context.addIssue({ code: "custom", message: snapshotBudgetMessage("1 MiB encoded size") });
    }
  });

export type AccountErasureRemoteSnapshot = z.infer<typeof accountErasureRemoteSnapshotSchema>;

function parseSnapshot(value: unknown): AccountErasureRemoteSnapshot {
  const parsed = accountErasureRemoteSnapshotSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  const budgetIssue = parsed.error.issues.find((issue) =>
    issue.message.startsWith("Account deletion snapshot exceeds"),
  );
  if (budgetIssue) throw new AccountErasureSnapshotBudgetError(budgetIssue.message);
  throw parsed.error;
}

async function encryptSnapshot(value: unknown, userId: string): Promise<string> {
  const plaintext = JSON.stringify(parseSnapshot(value));
  const encrypted = await encryptCredentialValue(plaintext, snapshotEncryptionContext(userId));
  assertAccountErasureSnapshotEncryptedBytes(Buffer.byteLength(encrypted, "utf8"));
  return encrypted;
}

function snapshotEncryptionContext(userId: string) {
  return {
    tableName: "fitness.account_erasure_request",
    columnName: "encrypted_remote_snapshot",
    scopeId: userId,
  };
}

/** Commit refreshed revocation credentials into the request's canonical encrypted snapshot. */
export async function updateAccountErasureProviderCredentials(
  database: Pick<Database, "transaction">,
  requestId: string,
  leaseOwner: string,
  providerId: string,
  tokens: TokenSet,
): Promise<string> {
  return database.transaction(async (transaction) => {
    const [request] = await executeWithSchema(
      transaction,
      z.object({
        user_id: z.uuid(),
        encrypted_remote_snapshot: z.string().nullable(),
        encrypted_snapshot_bytes: z.coerce.number().int().nonnegative(),
      }),
      sql`SELECT user_id,octet_length(encrypted_remote_snapshot) AS encrypted_snapshot_bytes,
        CASE WHEN octet_length(encrypted_remote_snapshot)<=${ACCOUNT_ERASURE_SNAPSHOT_LIMITS.encryptedBytes}
          THEN encrypted_remote_snapshot ELSE NULL END AS encrypted_remote_snapshot
      FROM fitness.account_erasure_request
      WHERE id = ${requestId}::uuid AND lease_owner = ${leaseOwner}
        AND lease_expires_at > now() AND status <> 'completed'
        AND user_id IS NOT NULL AND pii_scrubbed_at IS NULL AND encrypted_remote_snapshot IS NOT NULL
      FOR UPDATE`,
    );
    if (!request) throw new Error("Account erasure credential update lost its request lease");
    assertAccountErasureSnapshotEncryptedBytes(request.encrypted_snapshot_bytes);
    if (request.encrypted_remote_snapshot === null)
      throw new Error("Account erasure request does not retain a snapshot");
    const snapshot = await decryptAccountErasureSnapshot(
      request.encrypted_remote_snapshot,
      request.user_id,
    );
    let found = false;
    snapshot.providerConnections = snapshot.providerConnections.map((connection) => {
      if (
        connection.providerId !== providerId ||
        connection.disposition !== "revocation_credentials"
      )
        return connection;
      found = true;
      return { ...connection, ...tokens, expiresAt: tokens.expiresAt.toISOString() };
    });
    if (!found) throw new Error(`Account erasure has no revocation credentials for ${providerId}`);
    const encrypted = await encryptSnapshot(snapshot, request.user_id);
    await transaction.execute(sql`UPDATE fitness.account_erasure_request
      SET encrypted_remote_snapshot = ${encrypted}, updated_at = now()
      WHERE id = ${requestId}::uuid`);
    return encrypted;
  });
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
      if (
        [
          "kilter",
          "crimpd",
          "eight-a",
          "tension",
          "grasshopper",
          "decoy",
          "soill",
          "touchstone",
          "aurora-board",
        ].includes(connection.provider_id)
      ) {
        throw new ProviderRevocationPrerequisiteError(
          `Disconnect ${providerLabel(connection.provider_id)} in Dofek before deleting your account because remote session revocation is unavailable.`,
        );
      }
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
      if (connection.provider_id === "ziva") {
        throw new ProviderRevocationPrerequisiteError(
          "Disconnect Ziva in Dofek before deleting your account because Ziva does not advertise remote token revocation.",
        );
      }
      const provider = providersById.get(connection.provider_id);
      if (!provider) {
        throw new ProviderRevocationPrerequisiteError(
          `Dofek cannot verify the ${connection.provider_id} connection for account deletion. Contact support before retrying.`,
        );
      }
      if (connection.provider_id === "thecrag") {
        const tokens = await loadTokens(database, connection.provider_id, userId);
        if (tokens && !isTheCragPublicProfileScope(tokens.scopes)) {
          throw new ProviderRevocationPrerequisiteError(
            "Revoke your personal API key in theCrag Settings > API Keys, then disconnect theCrag in Dofek before deleting your account.",
          );
        }
        return {
          disposition: "no_remote_authorization" as const,
          providerId: connection.provider_id,
        };
      }
      if (getProviderAuthTypeFromSetup(provider.authSetup?.()) === "public-profile") {
        return {
          disposition: "no_remote_authorization" as const,
          providerId: connection.provider_id,
        };
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
        ...(tokens.authorizationId ? { authorizationId: tokens.authorizationId } : {}),
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
  await assertAccountErasureSnapshotSourceBudget(database, userId);
  const [
    providerConnections,
    webhooks,
    billingRows,
    appleCredentials,
    processorEmailRows,
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
  const snapshot: AccountErasureRemoteSnapshot = {
    appleCredentials,
    authIdentities: authIdentityRows.map((row) => ({
      authProvider: row.auth_provider,
      email: row.email,
      providerAccountId: row.provider_account_id,
    })),
    externalEffects,
    localIdentifiers: {
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
      sessionIds: sessionRows.map((row) => row.id),
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
  };
  return encryptSnapshot(snapshot, userId);
}

export async function decryptAccountErasureSnapshot(
  encryptedSnapshot: string,
  userId: string,
): Promise<AccountErasureRemoteSnapshot> {
  assertAccountErasureSnapshotEncryptedBytes(Buffer.byteLength(encryptedSnapshot, "utf8"));
  const plaintext = await decryptCredentialValue(
    encryptedSnapshot,
    snapshotEncryptionContext(userId),
  );
  if (Buffer.byteLength(plaintext, "utf8") > ACCOUNT_ERASURE_SNAPSHOT_LIMITS.plaintextBytes) {
    throw new AccountErasureSnapshotBudgetError(snapshotBudgetMessage("1 MiB encoded size"));
  }
  return parseSnapshot(JSON.parse(plaintext));
}
