import { and, eq } from "drizzle-orm";
import type { TokenSet } from "../auth/oauth.ts";
import {
  decryptCredentialValue,
  encryptCredentialValue,
} from "../security/credential-encryption.ts";
import type { SyncDatabase } from "./index.ts";
import { oauthToken, provider } from "./schema.ts";
import { getTokenUserId } from "./token-user-context.ts";

function resolveUserId(userId?: string): string {
  const scopedUserId = userId ?? getTokenUserId();
  if (!scopedUserId) {
    throw new Error(
      "Token operation requires userId (pass userId explicitly or run inside runWithTokenUser).",
    );
  }
  return scopedUserId;
}

function oauthTokenContext(
  scopedUserId: string,
  providerId: string,
  columnName: "access_token" | "refresh_token",
): {
  tableName: string;
  columnName: string;
  scopeId: string;
} {
  return {
    tableName: "fitness.oauth_token",
    columnName,
    scopeId: `${scopedUserId}:${providerId}`,
  };
}

/**
 * Ensure a provider row exists. Idempotent — does nothing if already present.
 */
export async function ensureProvider(
  db: SyncDatabase,
  id: string,
  name: string,
  apiBaseUrl?: string,
  userId?: string,
): Promise<string> {
  const resolvedUserId = resolveUserId(userId);
  const values = { id, name, apiBaseUrl, userId: resolvedUserId };
  try {
    await db.insert(provider).values(values).onConflictDoUpdate({
      target: provider.id,
      set: { name, apiBaseUrl },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`ensureProvider(${id}) failed for user ${resolvedUserId}: ${message}`, {
      cause: error,
    });
  }
  return id;
}

/**
 * Save (upsert) OAuth tokens for a provider scoped to a user.
 */
export async function saveTokens(
  db: SyncDatabase,
  providerId: string,
  tokens: TokenSet,
  userId?: string,
): Promise<void> {
  const scopedUserId = resolveUserId(userId);
  const encryptedAccessToken = await encryptCredentialValue(
    tokens.accessToken,
    oauthTokenContext(scopedUserId, providerId, "access_token"),
  );
  const encryptedRefreshToken = tokens.refreshToken
    ? await encryptCredentialValue(
        tokens.refreshToken,
        oauthTokenContext(scopedUserId, providerId, "refresh_token"),
      )
    : null;
  await db
    .insert(oauthToken)
    .values({
      userId: scopedUserId,
      providerId,
      accessToken: encryptedAccessToken,
      refreshToken: encryptedRefreshToken,
      expiresAt: tokens.expiresAt,
      scopes: tokens.scopes,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [oauthToken.userId, oauthToken.providerId],
      set: {
        accessToken: encryptedAccessToken,
        refreshToken: encryptedRefreshToken,
        expiresAt: tokens.expiresAt,
        scopes: tokens.scopes,
        updatedAt: new Date(),
      },
    });
}

/**
 * Delete stored tokens for a provider scoped to a user
 * (e.g., after a revoked refresh token).
 * After deletion, `loadTokens` returns null and the provider won't be synced
 * until the user re-authorizes.
 */
export async function deleteTokens(
  db: SyncDatabase,
  providerId: string,
  userId?: string,
): Promise<void> {
  const scopedUserId = resolveUserId(userId);
  await db
    .delete(oauthToken)
    .where(and(eq(oauthToken.providerId, providerId), eq(oauthToken.userId, scopedUserId)));
}

/**
 * Load stored tokens for a provider scoped to a user. Returns null if none exist.
 */
export async function loadTokens(
  db: SyncDatabase,
  providerId: string,
  userId?: string,
): Promise<TokenSet | null> {
  const scopedUserId = resolveUserId(userId);
  const rows = await db
    .select()
    .from(oauthToken)
    .where(and(eq(oauthToken.providerId, providerId), eq(oauthToken.userId, scopedUserId)))
    .limit(1);

  if (rows.length === 0) return null;

  const row = rows[0];
  if (!row) return null;
  const decryptedAccessToken = await decryptCredentialValue(
    row.accessToken,
    oauthTokenContext(scopedUserId, providerId, "access_token"),
  );
  const decryptedRefreshToken = row.refreshToken
    ? await decryptCredentialValue(
        row.refreshToken,
        oauthTokenContext(scopedUserId, providerId, "refresh_token"),
      )
    : null;
  return {
    accessToken: decryptedAccessToken,
    refreshToken: decryptedRefreshToken,
    expiresAt: row.expiresAt,
    scopes: row.scopes ?? null,
  };
}
