import type { SyncDatabase } from "../db/index.ts";
import { deleteTokens, loadTokens, saveTokens } from "../db/tokens.ts";
import { logger } from "../logger.ts";
import { RefreshTokenRevokedError } from "../providers/auth-errors.ts";
import type { OAuthConfig, TokenSet } from "./oauth.ts";
import { refreshAccessToken } from "./oauth.ts";

type FetchFn = typeof globalThis.fetch;

/**
 * Shared OAuth token resolution for providers that follow the standard
 * load → check expiry → refresh → save pattern.
 *
 * Covers 17 OAuth providers (Strava, Fitbit, Wahoo, etc.) that previously
 * had near-identical `resolveTokens()` methods.
 *
 * Providers with custom token logic (Garmin internal tokens, Zwift athleteId,
 * etc.) should NOT use this — keep their own implementation. WHOOP uses
 * `resolveWhoopTokens()` in `src/providers/whoop/resolve-tokens.ts`.
 */
export async function resolveOAuthTokens(options: {
  db: SyncDatabase;
  providerId: string;
  providerName: string;
  getOAuthConfig: () => OAuthConfig | null | undefined;
  fetchFn?: FetchFn;
  forceRefresh?: boolean;
  validateRefreshedTokens?: (
    currentTokens: TokenSet,
    refreshedTokens: TokenSet,
  ) => void | Promise<void>;
}): Promise<TokenSet> {
  const {
    db,
    providerId,
    providerName,
    getOAuthConfig,
    fetchFn = globalThis.fetch,
    forceRefresh = false,
    validateRefreshedTokens,
  } = options;

  const tokens = await loadTokens(db, providerId);
  if (!tokens) {
    throw new Error(
      `No OAuth tokens found for ${providerName}. Run: health-data auth ${providerId}`,
    );
  }

  if (!forceRefresh && tokens.expiresAt > new Date()) {
    return tokens;
  }

  logger.info(`[${providerId}] Access token expired, refreshing...`);

  if (!tokens.refreshToken) {
    logger.warn(
      `[${providerId}] No refresh token is available, deleting stored tokens. ` +
        `User must re-authorize ${providerName}.`,
    );
    await deleteTokens(db, providerId);
    const revokedError = new RefreshTokenRevokedError(providerName);
    revokedError.message = `No refresh token for ${providerName}. ${revokedError.message}`;
    throw revokedError;
  }

  const config = getOAuthConfig();
  if (!config) {
    throw new Error(`OAuth config required to refresh ${providerName} tokens`);
  }

  try {
    const refreshed = await refreshAccessToken(config, tokens.refreshToken, fetchFn);
    await validateRefreshedTokens?.(tokens, refreshed);
    const resolvedTokens: TokenSet = {
      ...refreshed,
      providerAccountId: refreshed.providerAccountId ?? tokens.providerAccountId,
    };
    await saveTokens(db, providerId, resolvedTokens);
    return resolvedTokens;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    // When the authorization server returns invalid_grant, the refresh token
    // has been revoked or expired. Delete the stored tokens so the sync
    // scheduler stops retrying every cycle — the user must re-authorize.
    if (message.includes("invalid_grant") || message.includes("Too many unrevoked")) {
      logger.warn(
        `[${providerId}] Refresh token revoked, deleting stored tokens. ` +
          `User must re-authorize ${providerName}.`,
      );
      await deleteTokens(db, providerId);
      throw new RefreshTokenRevokedError(providerName, {
        cause: error instanceof Error ? error : undefined,
      });
    }
    throw error;
  }
}
