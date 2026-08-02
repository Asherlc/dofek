import { randomUUID } from "node:crypto";
import * as Sentry from "@sentry/node";
import {
  AccountErasureIdentityFencedError,
  AccountErasureUserFencedError,
  withAccountErasureUserAndIdentityWriteFence,
} from "dofek/db/account-erasure";
import { queryCache } from "dofek/lib/cache";
import type { Request, Response } from "express";
import { z } from "zod";
import { findExistingUserId, resolveOrCreateUser } from "../../auth/account-linking.ts";
import {
  clearOAuthFlowCookies,
  getLinkUserCookie,
  getMobileSchemeCookie,
  getOAuthFlowCookies,
  getPostLoginRedirectCookie,
  isValidMobileScheme,
  setSessionCookie,
} from "../../auth/cookies.ts";
import { revokeIdentityCredentials } from "../../auth/identity-credential-revocation.ts";
import { appleRevocationCredentialFromTokens, getIdentityProvider } from "../../auth/providers.ts";
import { createSession } from "../../auth/session.ts";
import { logger } from "../../logger.ts";
import {
  getDb,
  getIdentityFlowStoreRef,
  getMobileAuthExchangeStoreRef,
  getPostLoginRedirect,
  isIdentityProviderName,
  sanitizeReturnTo,
} from "./shared.ts";

/**
 * Apple sends a `user` JSON field in the form_post body on first authorization only.
 * This is the only chance to capture the user's real name — it's never included in the ID token.
 */
const appleUserSchema = z.object({
  name: z
    .object({
      firstName: z.string().optional(),
      lastName: z.string().optional(),
    })
    .optional(),
});

function parseAppleFormPostName(rawUser: unknown): string | null {
  if (typeof rawUser !== "string") return null;
  try {
    const parsed = appleUserSchema.safeParse(JSON.parse(rawUser));
    if (!parsed.success) return null;
    const parts = [parsed.data.name?.firstName, parsed.data.name?.lastName].filter(Boolean);
    return parts.length > 0 ? parts.join(" ") : null;
  } catch {
    return null;
  }
}

/**
 * Shared handler for identity provider OAuth callbacks.
 * Accepts code/state/error from either query params (GET) or form body (POST).
 * Apple Sign In uses response_mode=form_post, so the callback comes as a POST
 * where SameSite=Lax cookies are not sent. Falls back to server-side state map.
 */
export async function handleIdentityCallback(
  req: Request<{ provider: string }>,
  res: Response,
): Promise<void> {
  try {
    const providerNameRaw = req.params.provider;
    if (!isIdentityProviderName(providerNameRaw)) {
      res.status(404).type("text/plain").send("Unknown identity provider");
      return;
    }
    const providerName = providerNameRaw;

    // Read code/state/error from query params (GET) or body (POST form_post)
    const rawParams = req.method === "POST" ? req.body : req.query;
    const code = typeof rawParams.code === "string" ? rawParams.code : undefined;
    const stateParam = typeof rawParams.state === "string" ? rawParams.state : undefined;
    const error = typeof rawParams.error === "string" ? rawParams.error : undefined;

    if (error) {
      res.status(400).type("text/plain").send("Authorization denied");
      return;
    }
    if (!code || !stateParam) {
      res.status(400).type("text/plain").send("Missing code or state parameter");
      return;
    }

    // Try cookies first (works for GET redirects from Google)
    const cookieFlow = getOAuthFlowCookies(req);
    let storedState = cookieFlow.state;
    let codeVerifier = cookieFlow.codeVerifier;
    let linkUserId = getLinkUserCookie(req);
    let mobileScheme = getMobileSchemeCookie(req);
    let returnTo = getPostLoginRedirectCookie(req);
    clearOAuthFlowCookies(res);

    // Fall back to Redis-backed store when cookies are unavailable
    // (Apple form_post: SameSite=Lax cookies aren't sent on cross-site POST)
    const cookieHadState = !!cookieFlow.state;
    const cookieHadVerifier = !!cookieFlow.codeVerifier;
    let storeHit = false;
    const identityFlowStore = getIdentityFlowStoreRef();
    if (!storedState || !codeVerifier) {
      const flowEntry = await identityFlowStore.get(stateParam);
      if (flowEntry) {
        storeHit = true;
        storedState = stateParam;
        codeVerifier = flowEntry.codeVerifier;
        linkUserId = linkUserId ?? flowEntry.linkUserId;
        mobileScheme = mobileScheme ?? flowEntry.mobileScheme;
        returnTo = returnTo ?? sanitizeReturnTo(flowEntry.returnTo);
        await identityFlowStore.delete(stateParam);
      }
    }

    if (!storedState || !codeVerifier || stateParam !== storedState) {
      logger.warn(
        `[auth] Identity callback state mismatch for ${providerName}: ` +
          `cookieState=${cookieHadState}, cookieVerifier=${cookieHadVerifier}, ` +
          `storeHit=${storeHit}, method=${req.method}`,
      );
      res.status(400).type("text/plain").send("Invalid state — please try logging in again");
      return;
    }

    // Validate the authorization code
    const provider = getIdentityProvider(providerName);
    const { tokens, user: identityUser } = await provider.validateCallback(code, codeVerifier);

    // Apple only sends the user's name in the form_post body on first authorization —
    // it's never included in the ID token. Parse it here as a fallback.
    const appleFormPostName =
      providerName === "apple" && req.method === "POST"
        ? parseAppleFormPostName(rawParams.user)
        : null;
    const userName = identityUser.name ?? appleFormPostName;
    const appleClientId = process.env.APPLE_CLIENT_ID;
    if (providerName === "apple" && !appleClientId) {
      throw new Error("APPLE_CLIENT_ID is required for Apple credential revocation");
    }

    const identity = {
      providerAccountId: identityUser.sub,
      email: identityUser.email,
      emailVerified: identityUser.emailVerified,
      name: userName,
      groups: identityUser.groups,
      revocationCredential:
        providerName === "apple" && appleClientId
          ? appleRevocationCredentialFromTokens(tokens, appleClientId)
          : undefined,
    };
    const externalIdentities: Parameters<
      typeof withAccountErasureUserAndIdentityWriteFence
    >[2][number][] = [
      {
        authProvider: providerName,
        kind: "provider_account",
        providerAccountId: identity.providerAccountId,
      },
    ];
    if (identity.emailVerified && identity.email) {
      externalIdentities.push({ email: identity.email, kind: "email" });
    }
    const db = getDb();
    class IdentityTargetChangedError extends Error {
      constructor(readonly resolvedUserId: string) {
        super("Identity target changed during callback resolution");
      }
    }
    let result: {
      isNewUser: boolean;
      sessionInfo: Awaited<ReturnType<typeof createSession>> | null;
      userId: string;
    };
    try {
      let targetUserId =
        linkUserId ?? (await findExistingUserId(db, providerName, identity)) ?? randomUUID();
      while (true) {
        try {
          result = await withAccountErasureUserAndIdentityWriteFence(
            db,
            targetUserId,
            externalIdentities,
            async (transaction) => {
              const resolvedUserId =
                linkUserId ?? (await findExistingUserId(transaction, providerName, identity));
              if (resolvedUserId && resolvedUserId !== targetUserId) {
                throw new IdentityTargetChangedError(resolvedUserId);
              }
              const { userId, isNewUser } = await resolveOrCreateUser(
                transaction,
                providerName,
                identity,
                linkUserId,
                { newUserId: targetUserId },
              );
              return {
                userId,
                isNewUser,
                sessionInfo: linkUserId ? null : await createSession(transaction, userId),
              };
            },
          );
          break;
        } catch (error: unknown) {
          if (!(error instanceof IdentityTargetChangedError)) throw error;
          targetUserId = error.resolvedUserId;
        }
      }
    } catch (persistenceError: unknown) {
      try {
        await revokeIdentityCredentials(providerName, tokens, appleClientId);
      } catch (cleanupError: unknown) {
        Sentry.captureException(cleanupError, {
          tags: {
            source: "identity-callback",
            operation: "revoke-orphan-credentials",
          },
        });
      }
      throw persistenceError;
    }
    const { userId, isNewUser, sessionInfo } = result;

    if (linkUserId) {
      try {
        await queryCache.invalidateByPrefix(`${userId}:auth.linkedAccounts`);
      } catch (cacheError: unknown) {
        Sentry.captureException(cacheError);
        logger.warn(
          `[auth] Failed to invalidate linked-accounts cache for user ${userId}: ${cacheError}`,
        );
      }
    }

    if (sessionInfo) {
      // Mobile: redirect to app via deep link with session token
      if (mobileScheme && isValidMobileScheme(mobileScheme)) {
        logger.info(`[auth] User ${userId} logged in via ${providerName} (mobile)`);
        const exchangeCode = await getMobileAuthExchangeStoreRef().issue({
          kind: "session",
          sessionId: sessionInfo.sessionId,
          isNewUser,
        });
        res.redirect(`${mobileScheme}://auth/callback?code=${exchangeCode}`);
        return;
      }

      setSessionCookie(res, sessionInfo.sessionId, sessionInfo.expiresAt);
    }

    logger.info(`[auth] User ${userId} ${linkUserId ? "linked" : "logged in via"} ${providerName}`);
    res.redirect(linkUserId ? "/settings" : getPostLoginRedirect(returnTo, isNewUser));
  } catch (err: unknown) {
    if (
      err instanceof AccountErasureIdentityFencedError ||
      err instanceof AccountErasureUserFencedError
    ) {
      res.status(409).type("text/plain").send(err.message);
      return;
    }
    Sentry.captureException(err);
    const message = err instanceof Error ? err.message : String(err);
    const oauthCode =
      err instanceof Error && "code" in err && typeof err.code === "string" ? err.code : undefined;
    const oauthDescription =
      err instanceof Error && "description" in err && typeof err.description === "string"
        ? err.description
        : undefined;
    const details = [
      oauthCode && `code=${oauthCode}`,
      oauthDescription && `desc=${oauthDescription}`,
    ]
      .filter(Boolean)
      .join(", ");
    logger.error(
      `[auth] Identity callback failed for ${req.params.provider}: ${message}${details ? ` (${details})` : ""}`,
    );
    res.status(500).send("Login failed — please try again");
  }
}
