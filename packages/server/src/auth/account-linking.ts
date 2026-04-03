import type { Database } from "dofek/db";
import { DEFAULT_USER_ID } from "dofek/db/schema";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema } from "../lib/typed-sql.ts";
import { logger } from "../logger.ts";

export interface ProviderIdentity {
  providerAccountId: string;
  email: string | null;
  name: string | null;
  groups?: string[] | null;
}

export interface ResolveUserResult {
  userId: string;
  isNewUser: boolean;
}

export interface ResolveOrCreateUserOptions {
  requireEmailForNewUser?: boolean;
}

export class MissingEmailForSignupError extends Error {
  constructor(providerName: string) {
    super(`Email is required to finish signing up with ${providerName}`);
    this.name = "MissingEmailForSignupError";
  }
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
  db: Database,
  providerName: string,
  identity: ProviderIdentity,
  loggedInUserId?: string,
  options?: ResolveOrCreateUserOptions,
): Promise<ResolveUserResult> {
  // 1. Logged-in linking: always link to the current user
  if (loggedInUserId) {
    await upsertAuthAccount(db, loggedInUserId, providerName, identity);
    logger.info(
      `[auth] Linked ${providerName} account ${identity.providerAccountId} to logged-in user ${loggedInUserId}`,
    );
    return { userId: loggedInUserId, isNewUser: false };
  }

  // 2. Existing auth_account for this exact provider identity
  const existingAccount = await executeWithSchema(
    db,
    z.object({ user_id: z.string() }),
    sql`SELECT user_id FROM fitness.auth_account
        WHERE auth_provider = ${providerName} AND provider_account_id = ${identity.providerAccountId}
        LIMIT 1`,
  );

  const firstExisting = existingAccount[0];
  if (existingAccount.length > 0 && firstExisting) {
    return { userId: firstExisting.user_id, isNewUser: false };
  }

  // 3. Email-based auto-linking: find an existing user with the same email
  if (identity.email) {
    const emailMatch = await executeWithSchema(
      db,
      z.object({ id: z.string() }),
      sql`SELECT id FROM fitness.user_profile
          WHERE LOWER(email) = LOWER(${identity.email})
          LIMIT 1`,
    );
    const matchedUser = emailMatch[0];
    if (emailMatch.length > 0 && matchedUser) {
      await upsertAuthAccount(db, matchedUser.id, providerName, identity);
      logger.info(
        `[auth] Auto-linked ${providerName} to existing user ${matchedUser.id} by email ${identity.email}`,
      );
      return { userId: matchedUser.id, isNewUser: false };
    }

    // 3.5. Cross-provider email match: check if another auth_account has the same email.
    //      Catches the case where the user has different emails on different providers
    //      (e.g., Google email != Strava email) but previously connected a provider
    //      using this email.
    const crossProviderMatch = await executeWithSchema(
      db,
      z.object({ user_id: z.string() }),
      sql`SELECT user_id FROM fitness.auth_account
          WHERE LOWER(email) = LOWER(${identity.email})
          LIMIT 1`,
    );
    const crossMatched = crossProviderMatch[0];
    if (crossProviderMatch.length > 0 && crossMatched) {
      await upsertAuthAccount(db, crossMatched.user_id, providerName, identity);
      logger.info(
        `[auth] Cross-provider linked ${providerName} to user ${crossMatched.user_id} by auth_account email ${identity.email}`,
      );
      return { userId: crossMatched.user_id, isNewUser: false };
    }
  }

  if (!identity.email && options?.requireEmailForNewUser) {
    throw new MissingEmailForSignupError(providerName);
  }

  // 4. First-ever user: claim the default user profile
  const accountCount = await executeWithSchema(
    db,
    z.object({ count: z.string() }),
    sql`SELECT COUNT(*)::text AS count FROM fitness.auth_account`,
  );
  const countRow = accountCount[0];
  if (!countRow) throw new Error("Failed to query account count");
  const isFirstUser = parseInt(countRow.count, 10) === 0;

  if (isFirstUser) {
    if (identity.email || identity.name) {
      await db.execute(
        sql`UPDATE fitness.user_profile
            SET email = COALESCE(${identity.email}, email),
                name = COALESCE(${identity.name}, name),
                updated_at = NOW()
            WHERE id = ${DEFAULT_USER_ID}`,
      );
    }
    await upsertAuthAccount(db, DEFAULT_USER_ID, providerName, identity);
    logger.info(`[auth] First user claimed DEFAULT_USER_ID via ${providerName}`);
    return { userId: DEFAULT_USER_ID, isNewUser: true };
  }

  // 5. New user: create a user profile
  const newUser = await executeWithSchema(
    db,
    z.object({ id: z.string() }),
    sql`INSERT INTO fitness.user_profile (name, email)
        VALUES (${identity.name ?? "User"}, ${identity.email})
        RETURNING id`,
  );
  const newUserRow = newUser[0];
  if (!newUserRow) throw new Error("Failed to create user profile");

  await upsertAuthAccount(db, newUserRow.id, providerName, identity);
  logger.info(`[auth] Created new user ${newUserRow.id} via ${providerName}`);
  return { userId: newUserRow.id, isNewUser: true };
}

async function upsertAuthAccount(
  db: Database,
  userId: string,
  providerName: string,
  identity: ProviderIdentity,
): Promise<void> {
  await db.execute(
    sql`INSERT INTO fitness.auth_account (user_id, auth_provider, provider_account_id, email, name, groups)
        VALUES (${userId}, ${providerName}, ${identity.providerAccountId}, ${identity.email}, ${identity.name}, ${identity.groups ?? null})
        ON CONFLICT (auth_provider, provider_account_id)
        DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name, groups = EXCLUDED.groups`,
  );
}
