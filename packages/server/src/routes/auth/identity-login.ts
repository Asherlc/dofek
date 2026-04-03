import * as Sentry from "@sentry/node";
import type { Request, Response } from "express";
import {
  isValidMobileScheme,
  setMobileSchemeCookie,
  setOAuthFlowCookies,
  setPostLoginRedirectCookie,
} from "../../auth/cookies.ts";
import {
  generateCodeVerifier,
  generateState,
  getIdentityProvider,
  isProviderConfigured,
} from "../../auth/providers.ts";
import { logger } from "../../logger.ts";
import {
  getSinglePathParam,
  isIdentityProviderName,
  sanitizeReturnTo,
  storeIdentityFlow,
} from "./shared.ts";

export async function handleIdentityLogin(req: Request, res: Response): Promise<void> {
  try {
    const providerNameRaw = getSinglePathParam(req.params.provider);
    if (!providerNameRaw || !isIdentityProviderName(providerNameRaw)) {
      res.status(404).type("text/plain").send("Unknown identity provider");
      return;
    }
    const providerName = providerNameRaw;
    if (!isProviderConfigured(providerName)) {
      res.status(400).send("Provider is not configured");
      return;
    }

    const state = generateState();
    const codeVerifier = generateCodeVerifier();
    const provider = getIdentityProvider(providerName);

    // Encode the provider name in the state so the callback knows which provider
    const statePayload = `${providerName}:${state}`;
    const url = provider.createAuthorizationUrl(statePayload, codeVerifier);

    setOAuthFlowCookies(res, statePayload, codeVerifier);

    // Mobile apps pass redirect_scheme so the callback redirects via deep link
    const redirectScheme =
      typeof req.query.redirect_scheme === "string" ? req.query.redirect_scheme : undefined;
    if (redirectScheme && isValidMobileScheme(redirectScheme)) {
      setMobileSchemeCookie(res, redirectScheme);
    }

    const returnTo = typeof req.query.return_to === "string" ? req.query.return_to : undefined;
    setPostLoginRedirectCookie(res, returnTo);

    // Server-side fallback for providers that use form_post (Apple):
    // SameSite=Lax cookies aren't sent on cross-site POST requests.
    await storeIdentityFlow(statePayload, {
      codeVerifier,
      mobileScheme:
        redirectScheme && isValidMobileScheme(redirectScheme) ? redirectScheme : undefined,
      returnTo: sanitizeReturnTo(returnTo),
    });

    res.redirect(url.toString());
  } catch (err: unknown) {
    Sentry.captureException(err);
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`[auth] Failed to start login flow: ${message}`);
    res.status(500).send("Auth error: failed to start login flow");
  }
}
