import { randomBytes } from "node:crypto";
import * as Sentry from "@sentry/node";
import type { Router } from "express";
import { getSessionIdFromRequest, isValidMobileScheme } from "../../auth/cookies.ts";
import { validateSession } from "../../auth/session.ts";
import type { OAuthStateEntry } from "../../lib/oauth-state-store.ts";
import { logger } from "../../logger.ts";
import {
  authRateLimiter,
  getDb,
  getOAuth1SecretStoreRef,
  getOAuthStateStoreRef,
  getSinglePathParam,
  sanitizeReturnTo,
} from "./shared.ts";

export async function startDataProviderOAuth(
  req: import("express").Request,
  res: import("express").Response,
  providerId: string,
  stateEntry: OAuthStateEntry,
): Promise<void> {
  const { getAllProviders } = await import("dofek/providers/registry");
  const { ensureProvidersRegistered } = await import("../../routers/sync.ts");
  await ensureProvidersRegistered();

  const provider = getAllProviders().find((p) => p.id === providerId);
  if (!provider) {
    res.status(404).send("Unknown provider");
    return;
  }

  // Pass current host to ensure the redirect URI matches the server that started the flow
  const host = req.get("host");
  const setup = provider.authSetup?.({ host });
  if (!setup?.oauthConfig) {
    res.status(400).send("Provider does not use OAuth");
    return;
  }

  // Login intent requires getUserIdentity to extract user info from the provider
  if (stateEntry.intent === "login" && !setup.getUserIdentity) {
    res.status(400).send("Provider cannot be used for login");
    return;
  }

  // Credential providers use the generic credentialAuth.signIn tRPC endpoint instead
  if (setup.automatedLogin && stateEntry.intent === "data") {
    res
      .status(400)
      .send("Provider uses credential authentication and cannot be connected via OAuth here");
    return;
  }

  const oauth1SecretStore = getOAuth1SecretStoreRef();

  // OAuth 1.0 providers (e.g. FatSecret) — only for data intent
  if (setup.oauth1Flow && stateEntry.intent === "data") {
    const callbackUrl = setup.oauthConfig.redirectUri;
    const result = await setup.oauth1Flow.getRequestToken(callbackUrl);
    await oauth1SecretStore.save(result.oauthToken, {
      providerId,
      tokenSecret: result.oauthTokenSecret,
      userId: stateEntry.userId,
    });
    res.redirect(result.authorizeUrl);
    return;
  }

  const {
    buildAuthorizationUrl,
    generateCodeVerifier: genVerifier,
    generateCodeChallenge,
  } = await import("dofek/auth/oauth");

  let pkceVerifier: string | undefined;
  let pkceParam: { codeChallenge: string } | undefined;
  if (setup.oauthConfig.usePkce) {
    pkceVerifier = genVerifier();
    pkceParam = { codeChallenge: generateCodeChallenge(pkceVerifier) };
  }

  const oauthStateStore = getOAuthStateStoreRef();
  const url = buildAuthorizationUrl(setup.oauthConfig, pkceParam);
  const stateToken = randomBytes(16).toString("hex");
  await oauthStateStore.save(stateToken, { ...stateEntry, codeVerifier: pkceVerifier });
  const authUrl = new URL(url);
  authUrl.searchParams.set("state", stateToken);
  res.redirect(authUrl.toString());
}

export function registerDataProviderOAuthRoutes(router: Router): void {
  // ── Data provider login: use a data provider as an identity/login provider ──
  router.get("/auth/login/data/:provider", authRateLimiter, async (req, res) => {
    try {
      const providerId = getSinglePathParam(req.params.provider);
      if (!providerId) {
        res.status(400).send("Missing provider");
        return;
      }
      const redirectScheme =
        typeof req.query.redirect_scheme === "string" ? req.query.redirect_scheme : undefined;
      const mobileScheme =
        redirectScheme && isValidMobileScheme(redirectScheme) ? redirectScheme : undefined;
      const returnTo = sanitizeReturnTo(
        typeof req.query.return_to === "string" ? req.query.return_to : undefined,
      );
      await startDataProviderOAuth(req, res, providerId, {
        providerId,
        intent: "login",
        userId: `login:${randomBytes(8).toString("hex")}`,
        mobileScheme,
        returnTo,
      });
    } catch (err: unknown) {
      Sentry.captureException(err);
      logger.error(`[auth] Failed to start data provider login: ${err}`);
      res.status(500).send("Auth error: failed to start login flow");
    }
  });

  // ── Data provider link: link a data provider as identity while already logged in ──
  router.get("/auth/link/data/:provider", authRateLimiter, async (req, res) => {
    try {
      const providerId = getSinglePathParam(req.params.provider);
      if (!providerId) {
        res.status(400).send("Missing provider");
        return;
      }
      const sessionId = getSessionIdFromRequest(req);
      if (!sessionId) {
        res.status(401).send("You must be logged in to link an account");
        return;
      }
      const session = await validateSession(getDb(), sessionId);
      if (!session) {
        res.status(401).send("Session expired — please log in first");
        return;
      }

      await startDataProviderOAuth(req, res, providerId, {
        providerId,
        intent: "link",
        linkUserId: session.userId,
        userId: session.userId,
      });
    } catch (err: unknown) {
      Sentry.captureException(err);
      logger.error(`[auth] Failed to start data provider link: ${err}`);
      res.status(500).send("Auth error: failed to start link flow");
    }
  });

  // ── Data-provider OAuth for data sync (Wahoo, Withings, etc.) ──
  router.get("/auth/provider/:provider", authRateLimiter, async (req, res) => {
    try {
      const providerId = getSinglePathParam(req.params.provider);
      if (!providerId) {
        res.status(400).send("Missing provider");
        return;
      }
      // 1. Check if provider exists first (returns 404 if not)
      const { getAllProviders } = await import("dofek/providers/registry");
      const { ensureProvidersRegistered } = await import("../../routers/sync.ts");
      await ensureProvidersRegistered();
      const provider = getAllProviders().find((candidate) => candidate.id === providerId);
      if (!provider) {
        res.status(404).send("Unknown provider");
        return;
      }
      // 2. Then check session (returns 401 if not logged in)
      const sessionId = getSessionIdFromRequest(req);
      const db = getDb();
      const session = sessionId ? await validateSession(db, sessionId) : null;
      if (!session) {
        res.status(401).send("You must be logged in to connect a provider");
        return;
      }
      const userId = session.userId;

      await startDataProviderOAuth(req, res, providerId, {
        providerId,
        intent: "data",
        userId,
      });
    } catch (err: unknown) {
      Sentry.captureException(err);
      logger.error(`[auth] Failed to start OAuth flow: ${err}`);
      res.status(500).send("Auth error: failed to start OAuth flow");
    }
  });
}
