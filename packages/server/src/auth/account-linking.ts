import type { Database } from "dofek/db";
import { encryptCredentialValue } from "dofek/security/credential-encryption";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema } from "../lib/typed-sql.ts";
import { logger } from "../logger.ts";

export interface ProviderIdentity {
  providerAccountId: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  groups?: string[] | null;
  revocationCredential?: {
    accessToken: string;
    clientId: string;
    refreshToken: string | null;
  };
}

export interface ResolveUserResult {
  userId: string;
  isNewUser: boolean;
}

export interface ResolveOrCreateUserOptions {
  newUserId?: string;
  requireEmailForNewUser?: boolean;
}

export class MissingEmailForSignupError extends Error {
  constructor(providerName: string) {
    super(`Email is required to finish signing up with ${providerName}`);
    this.name = "MissingEmailForSignupError";
  }
}

export async function findExistingUserId(
  db: Pick<Database, "execute">,
  providerName: string,
  identity: ProviderIdentity,
  loggedInUserId?: string,
): Promise<string | null> {
  if (loggedInUserId) return loggedInUserId;

  const existingAccount = await executeWithSchema(
    db,
    z.object({ user_id: z.string() }),
    sql`SELECT user_id FROM fitness.auth_account
        WHERE auth_provider = ${providerName} AND provider_account_id = ${identity.providerAccountId}
        LIMIT 1`,
  );
  const exactUserId = existingAccount[0]?.user_id;
  if (exactUserId) return exactUserId;

  if (!identity.email || !identity.emailVerified) return null;

  const emailMatch = await executeWithSchema(
    db,
    z.object({ id: z.string() }),
    sql`SELECT id FROM fitness.user_profile
        WHERE LOWER(email) = LOWER(${identity.email})
        LIMIT 1`,
  );
  const profileUserId = emailMatch[0]?.id;
  if (profileUserId) return profileUserId;

  const crossProviderMatch = await executeWithSchema(
    db,
    z.object({ user_id: z.string() }),
    sql`SELECT user_id FROM fitness.auth_account
        WHERE LOWER(email) = LOWER(${identity.email})
        LIMIT 1`,
  );
  return crossProviderMatch[0]?.user_id ?? null;
}

/**
 * Resolve or create a user from an identity provider's claims.
 *
 * Resolution order:
 * 1. If loggedInUserId is provided, link to that user (account linking flow).
 * 2. Lookup existing auth_account by (providerName, providerAccountId).
 * 3. Lookup user_profile by email match (email-based auto-linking).
 * 3.5. Cross-provider email match: check if another auth_account has the same email.
 * 4. Create a new user_profile.
 *
 * In all cases where the auth_account doesn't yet exist, it is created.
 */
export async function resolveOrCreateUser(
  db: Pick<Database, "execute">,
  providerName: string,
  identity: ProviderIdentity,
  loggedInUserId?: string,
  options?: ResolveOrCreateUserOptions,
): Promise<ResolveUserResult> {
  const existingUserId = await findExistingUserId(db, providerName, identity, loggedInUserId);
  if (existingUserId) {
    await upsertAuthAccount(db, existingUserId, providerName, identity);
    logger.info(
      `[auth] Linked ${providerName} account ${identity.providerAccountId} to existing user ${existingUserId}`,
    );
    return { userId: existingUserId, isNewUser: false };
  }

  if (!identity.email && options?.requireEmailForNewUser) {
    throw new MissingEmailForSignupError(providerName);
  }

  // 4. Create a new user profile; unverified email claims are not canonical account data.
  const profileEmail = identity.emailVerified ? identity.email : null;
  const newUser = await executeWithSchema(
    db,
    z.object({ id: z.string() }),
    sql`INSERT INTO fitness.user_profile (id, name, email)
        VALUES (
          COALESCE(${options?.newUserId ?? null}::uuid, gen_random_uuid()),
          ${identity.name ?? "User"},
          ${profileEmail}
        )
        RETURNING id`,
  );
  const newUserRow = newUser[0];
  if (!newUserRow) throw new Error("Failed to create user profile");

  await upsertAuthAccount(db, newUserRow.id, providerName, identity);
  logger.info(`[auth] Created new user ${newUserRow.id} via ${providerName}`);
  return { userId: newUserRow.id, isNewUser: true };
}

async function upsertAuthAccount(
  db: Pick<Database, "execute">,
  userId: string,
  providerName: string,
  identity: ProviderIdentity,
): Promise<void> {
  const accountEmail = identity.emailVerified ? identity.email : null;
  const credentialScopeId = `${providerName}:${identity.providerAccountId}`;
  const encryptedAccessToken = identity.revocationCredential
    ? await encryptCredentialValue(identity.revocationCredential.accessToken, {
        tableName: "fitness.auth_account",
        columnName: "revocation_access_token",
        scopeId: credentialScopeId,
      })
    : null;
  const encryptedRefreshToken = identity.revocationCredential?.refreshToken
    ? await encryptCredentialValue(identity.revocationCredential.refreshToken, {
        tableName: "fitness.auth_account",
        columnName: "revocation_refresh_token",
        scopeId: credentialScopeId,
      })
    : null;
  const linkedAccounts = await executeWithSchema(
    db,
    z.object({ user_id: z.string() }),
    sql`INSERT INTO fitness.auth_account (
          user_id,
          auth_provider,
          provider_account_id,
          email,
          name,
          groups,
          revocation_access_token,
          revocation_refresh_token,
          revocation_client_id
        )
        VALUES (
          ${userId},
          ${providerName},
          ${identity.providerAccountId},
          ${accountEmail},
          ${identity.name},
          ${identity.groups ?? null},
          ${encryptedAccessToken},
          ${encryptedRefreshToken},
          ${identity.revocationCredential?.clientId ?? null}
        )
        ON CONFLICT (auth_provider, provider_account_id)
        DO UPDATE SET
          email = EXCLUDED.email,
          name = EXCLUDED.name,
          groups = EXCLUDED.groups,
          revocation_access_token = COALESCE(
            EXCLUDED.revocation_access_token,
            fitness.auth_account.revocation_access_token
          ),
          revocation_refresh_token = COALESCE(
            EXCLUDED.revocation_refresh_token,
            fitness.auth_account.revocation_refresh_token
          ),
          revocation_client_id = COALESCE(
            EXCLUDED.revocation_client_id,
            fitness.auth_account.revocation_client_id
          )
        WHERE fitness.auth_account.user_id = EXCLUDED.user_id
        RETURNING user_id`,
  );
  if (linkedAccounts[0]?.user_id !== userId) {
    throw new Error(`${providerName} account is already linked to another user`);
  }
}
