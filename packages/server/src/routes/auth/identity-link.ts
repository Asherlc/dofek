import * as Sentry from "@sentry/node";
import type { Request, Response } from "express";
import {
  getSessionIdFromRequest,
  setLinkUserCookie,
  setOAuthFlowCookies,
} from "../../auth/cookies.ts";
import {
  generateCodeVerifier,
  generateState,
  getIdentityProvider,
  isProviderConfigured,
} from "../../auth/providers.ts";
import { validateSession } from "../../auth/session.ts";
import { logger } from "../../logger.ts";
import { getDb, getSinglePathParam, isIdentityProviderName, storeIdentityFlow } from "./shared.ts";

export async function handleIdentityLink(req: Request, res: Response): Promise<void> {
  try {
    const providerNameRaw = getSinglePathParam(req.params.provider);
    if (!providerNameRaw || !isIdentityProviderName(providerNameRaw)) {
      res.status(404).type("text/plain").send("Unknown identity provider");
      return;
    }
    const providerName = providerNameRaw;
    if (!isProviderConfigured(providerName)) {
      res.status(400).send(`Provider ${providerName} is not configured`);
      return;
    }

    // Require valid session
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

    const state = generateState();
    const codeVerifier = generateCodeVerifier();
    const provider = getIdentityProvider(providerName);

    const statePayload = `${providerName}:${state}`;
    const url = provider.createAuthorizationUrl(statePayload, codeVerifier);

    setOAuthFlowCookies(res, statePayload, codeVerifier);
    setLinkUserCookie(res, session.userId);

    // Server-side fallback (same reason as login handler above)
    await storeIdentityFlow(statePayload, {
      codeVerifier,
      linkUserId: session.userId,
    });

    res.redirect(url.toString());
  } catch (err: unknown) {
    Sentry.captureException(err);
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`[auth] Failed to start link flow: ${message}`);
    res.status(500).send("Auth error: failed to start link flow");
  }
}
