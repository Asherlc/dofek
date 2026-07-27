import { WhoopClient } from "@dofek/whoop/client";
import type { WhoopAuthToken } from "@dofek/whoop/types";
import { z } from "zod";
import type { TokenSet } from "../../auth/oauth.ts";
import type { SyncDatabase } from "../../db/index.ts";
import { deleteTokens, loadTokens, saveTokens } from "../../db/tokens.ts";
import { logger } from "../../logger.ts";
import { ProviderStoredIdentityMissingError, RefreshTokenRevokedError } from "../auth-errors.ts";

export const WHOOP_PROVIDER_ID = "whoop";

type FetchFn = typeof globalThis.fetch;

const WHOOP_ACCESS_TOKEN_REFRESH_WINDOW_MS = 3_600_000;

const whoopRefreshTokenSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  userId: z.number().int().nullable(),
  expiresInSeconds: z.number().positive(),
});

export function parseWhoopUserIdFromScopes(scopes: string | null | undefined): number | null {
  const match = scopes?.match(/userId:(\d+)/);
  return match ? Number(match[1]) : null;
}

export function buildWhoopTokenSet(token: WhoopAuthToken): TokenSet {
  return {
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    expiresAt: new Date(Date.now() + token.expiresInSeconds * 1000),
    scopes: `userId:${token.userId}`,
  };
}

export async function saveWhoopAuthTokens(
  db: SyncDatabase,
  token: WhoopAuthToken,
  userId?: string,
): Promise<void> {
  await saveTokens(db, WHOOP_PROVIDER_ID, buildWhoopTokenSet(token), userId);
}

function isWhoopRefreshTokenRevoked(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("NotAuthorizedException");
}

/**
 * Shared WHOOP Cognito token resolution: load stored tokens, reuse a valid
 * access token when possible, otherwise refresh via Cognito and persist.
 */
export async function resolveWhoopTokens(options: {
  db: SyncDatabase;
  fetchFn?: FetchFn;
  userId?: string;
}): Promise<WhoopAuthToken> {
  const { db, fetchFn = globalThis.fetch, userId } = options;

  const stored = await loadTokens(db, WHOOP_PROVIDER_ID, userId);
  if (!stored?.refreshToken) {
    throw new Error("WHOOP not connected — authenticate via the web UI");
  }

  const storedUserId = parseWhoopUserIdFromScopes(stored.scopes);
  const now = Date.now();
  const accessTokenOutsideRefreshWindow =
    stored.expiresAt.getTime() - now > WHOOP_ACCESS_TOKEN_REFRESH_WINDOW_MS;

  if (accessTokenOutsideRefreshWindow && storedUserId != null) {
    const remainingSeconds = Math.max(0, Math.floor((stored.expiresAt.getTime() - now) / 1000));
    return {
      accessToken: stored.accessToken,
      refreshToken: stored.refreshToken,
      userId: storedUserId,
      expiresInSeconds: remainingSeconds,
    };
  }

  try {
    const refreshed = whoopRefreshTokenSchema.parse(
      await WhoopClient.refreshAccessToken(stored.refreshToken, fetchFn),
    );
    const resolvedUserId = storedUserId ?? refreshed.userId;
    if (!resolvedUserId) {
      throw new ProviderStoredIdentityMissingError("WHOOP", "user ID");
    }

    const token: WhoopAuthToken = {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      userId: resolvedUserId,
      expiresInSeconds: refreshed.expiresInSeconds,
    };
    await saveWhoopAuthTokens(db, token, userId);
    return token;
  } catch (error: unknown) {
    if (isWhoopRefreshTokenRevoked(error)) {
      logger.warn(
        "[whoop] Cognito refresh token rejected — deleting stored tokens. User must reconnect WHOOP.",
      );
      await deleteTokens(db, WHOOP_PROVIDER_ID, userId);
      throw new RefreshTokenRevokedError("WHOOP", {
        cause: error instanceof Error ? error : undefined,
      });
    }
    throw error;
  }
}
