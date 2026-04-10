import * as Sentry from "@sentry/node";
import type { Request, Response } from "express";
import { z } from "zod";
import { resolveOrCreateUser } from "../../auth/account-linking.ts";
import {
  clearOAuthFlowCookies,
  getLinkUserCookie,
  getMobileSchemeCookie,
  getOAuthFlowCookies,
  getPostLoginRedirectCookie,
  isValidMobileScheme,
  setSessionCookie,
} from "../../auth/cookies.ts";
import { getIdentityProvider } from "../../auth/providers.ts";
import { createSession } from "../../auth/session.ts";
import { queryCache } from "../../lib/cache.ts";
import { logger } from "../../logger.ts";
import {
  getDb,
  getIdentityFlowStoreRef,
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
    const { user: identityUser } = await provider.validateCallback(code, codeVerifier);

    // Apple only sends the user's name in the form_post body on first authorization —
    // it's never included in the ID token. Parse it here as a fallback.
    const appleFormPostName =
      providerName === "apple" && req.method === "POST"
        ? parseAppleFormPostName(rawParams.user)
        : null;
    const userName = identityUser.name ?? appleFormPostName;

    const db = getDb();

    // Resolve or create user (with email-based auto-linking and optional logged-in linking)
    const { userId } = await resolveOrCreateUser(
      db,
      providerName,
      {
        providerAccountId: identityUser.sub,
        email: identityUser.email,
        name: userName,
        groups: identityUser.groups,
      },
      linkUserId,
    );

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

    // Create session (or keep existing if linking)
    if (!linkUserId) {
      const sessionInfo = await createSession(db, userId);

      // Mobile: redirect to app via deep link with session token
      if (mobileScheme && isValidMobileScheme(mobileScheme)) {
        logger.info(`[auth] User ${userId} logged in via ${providerName} (mobile)`);
        res.redirect(`${mobileScheme}://auth/callback?session=${sessionInfo.sessionId}`);
        return;
      }

      setSessionCookie(res, sessionInfo.sessionId, sessionInfo.expiresAt);
    }

    logger.info(`[auth] User ${userId} ${linkUserId ? "linked" : "logged in via"} ${providerName}`);
    res.redirect(linkUserId ? "/settings" : (sanitizeReturnTo(returnTo) ?? "/"));
  } catch (err: unknown) {
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
