import type { Database } from "dofek/db";
import { DEFAULT_USER_ID } from "dofek/db/schema";
import { sql } from "drizzle-orm";
import { logger } from "../logger.ts";

export interface ProviderIdentity {
  providerAccountId: string;
  email: string | null;
  name: string | null;
}

export interface ResolveUserResult {
  userId: string;
  isNewUser: boolean;
}

/**
 * Resolve or create a user from an identity provider's claims.
 *
 * Resolution order:
 * 1. If loggedInUserId is provided, link to that user (account linking flow).
 * 2. Lookup existing auth_account by (providerName, providerAccountId).
 * 3. Lookup user_profile by email match (email-based auto-linking).
 * 4. If no accounts exist at all, claim DEFAULT_USER_ID (first-user migration).
 * 5. Create a new user_profile.
 *
 * In all cases where the auth_account doesn't yet exist, it is created.
 */
export async function resolveOrCreateUser(
  db: Database,
  providerName: string,
  identity: ProviderIdentity,
  loggedInUserId?: string,
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
  const existingAccount = await db.execute<{ user_id: string }>(
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
    const emailMatch = await db.execute<{ id: string }>(
      sql`SELECT id FROM fitness.user_profile
          WHERE email = ${identity.email}
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
  }

  // 4. First-ever user: claim the default user profile
  const accountCount = await db.execute<{ count: string }>(
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
  const newUser = await db.execute<{ id: string }>(
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
    sql`INSERT INTO fitness.auth_account (user_id, auth_provider, provider_account_id, email, name)
        VALUES (${userId}, ${providerName}, ${identity.providerAccountId}, ${identity.email}, ${identity.name})
        ON CONFLICT (auth_provider, provider_account_id)
        DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name`,
  );
}
