import { eq } from "drizzle-orm";
import type { TokenSet } from "../auth/oauth.ts";
import type { Database } from "./index.ts";
import { oauthToken, provider } from "./schema.ts";

/**
 * Ensure a provider row exists. Idempotent — does nothing if already present.
 */
export async function ensureProvider(
  db: Database,
  id: string,
  name: string,
  apiBaseUrl?: string,
): Promise<string> {
  await db
    .insert(provider)
    .values({ id, name, apiBaseUrl })
    .onConflictDoNothing({ target: provider.id });
  return id;
}

/**
 * Save (upsert) OAuth tokens for a provider.
 */
export async function saveTokens(
  db: Database,
  providerId: string,
  tokens: TokenSet,
): Promise<void> {
  await db
    .insert(oauthToken)
    .values({
      providerId,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      scopes: tokens.scopes,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: oauthToken.providerId,
      set: {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        scopes: tokens.scopes,
        updatedAt: new Date(),
      },
    });
}

/**
 * Load stored tokens for a provider. Returns null if none exist.
 */
export async function loadTokens(db: Database, providerId: string): Promise<TokenSet | null> {
  const rows = await db
    .select()
    .from(oauthToken)
    .where(eq(oauthToken.providerId, providerId))
    .limit(1);

  if (rows.length === 0) return null;

  const row = rows[0];
  return {
    accessToken: row.accessToken,
    refreshToken: row.refreshToken,
    expiresAt: row.expiresAt,
    scopes: row.scopes ?? "",
  };
}
