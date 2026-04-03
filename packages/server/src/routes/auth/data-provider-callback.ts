import * as Sentry from "@sentry/node";
import { revokeToken } from "dofek/auth/oauth";
import type { Request, Response } from "express";
import { MissingEmailForSignupError, resolveOrCreateUser } from "../../auth/account-linking.ts";
import {
  getSessionIdFromRequest,
  isValidMobileScheme,
  setSessionCookie,
} from "../../auth/cookies.ts";
import { createSession, validateSession } from "../../auth/session.ts";
import { queryCache } from "../../lib/cache.ts";
import { logger } from "../../logger.ts";
import {
  completeSignupHtml,
  getDb,
  getOAuth1SecretStoreRef,
  getOAuthStateStoreRef,
  oauthSuccessHtml,
  persistProviderConnection,
  sanitizeReturnTo,
  storePendingEmailSignup,
} from "./shared.ts";
import { handleSlackCallback } from "./slack-oauth.ts";

export async function handleOAuth2Callback(req: Request, res: Response): Promise<void> {
  try {
    const code = typeof req.query.code === "string" ? req.query.code : undefined;
    const state = typeof req.query.state === "string" ? req.query.state : undefined;
    const error = typeof req.query.error === "string" ? req.query.error : undefined;
    const oauthToken =
      typeof req.query.oauth_token === "string" ? req.query.oauth_token : undefined;
    const oauthVerifier =
      typeof req.query.oauth_verifier === "string" ? req.query.oauth_verifier : undefined;

    // Bare GET with no params — providers (e.g. Withings) verify the URL is reachable
    if (!code && !state && !error && !oauthToken) {
      res.send("OK");
      return;
    }

    if (error) {
      res.status(400).type("text/plain").send("Authorization denied");
      return;
    }

    const db = getDb();
    const oauth1SecretStore = getOAuth1SecretStoreRef();
    const oauthStateStore = getOAuthStateStoreRef();

    // ── OAuth 1.0 callback (FatSecret) ──
    if (oauthToken && oauthVerifier) {
      const stored = await oauth1SecretStore.get(oauthToken);
      if (!stored) {
        res.status(400).send("Unknown or expired OAuth 1.0 request token");
        return;
      }
      await oauth1SecretStore.delete(oauthToken);

      const { getAllProviders } = await import("dofek/providers/registry");
      const { ensureProvidersRegistered } = await import("../../routers/sync.ts");
      await ensureProvidersRegistered();

      const provider = getAllProviders().find((p) => p.id === stored.providerId);
      if (!provider) {
        res.status(404).send("Unknown provider");
        return;
      }

      const setup = provider.authSetup?.({ host: req.get("host") });
      if (!setup?.oauth1Flow) {
        res.status(400).send("Provider does not support OAuth 1.0");
        return;
      }

      logger.info(`[auth] Exchanging OAuth 1.0 tokens for ${stored.providerId}...`);
      const { token, tokenSecret } = await setup.oauth1Flow.exchangeForAccessToken(
        oauthToken,
        stored.tokenSecret,
        oauthVerifier,
      );

      const { ensureProvider, saveTokens } = await import("dofek/db/tokens");
      await ensureProvider(db, provider.id, provider.name, undefined, stored.userId);
      // Store OAuth 1.0 tokens — token as accessToken, tokenSecret as refreshToken
      // OAuth 1.0 tokens don't expire
      await saveTokens(
        db,
        provider.id,
        {
          accessToken: token,
          refreshToken: tokenSecret,
          expiresAt: new Date("2099-12-31"),
          scopes: "",
        },
        stored.userId,
      );
      await queryCache.invalidateByPrefix(`${stored.userId}:sync.providers`);

      logger.info(`[auth] ${stored.providerId} OAuth 1.0 tokens saved.`);
      res.send(oauthSuccessHtml(provider.name, undefined, provider.id));
      return;
    }

    // ── OAuth 2.0 callback ──
    if (!code || !state) {
      res.status(400).send("Missing code or state parameter");
      return;
    }

    // ── Slack OAuth callback (Add to Slack) ──
    if (state.startsWith("slack:") && (await oauthStateStore.has(state))) {
      const slackState = await oauthStateStore.get(state);
      await handleSlackCallback(req, res, code, state, slackState);
      return;
    }

    // Resolve provider from random state token
    const stateEntry = await oauthStateStore.get(state);
    if (!stateEntry) {
      const errorDetail = req.get("host")?.includes("localhost")
        ? " (Are you using an IP or host that differs from what the provider redirected to? Try setting OAUTH_REDIRECT_URI_unencrypted in your .env if testing on mobile.)"
        : "";
      res.status(400).send(`Unknown or expired OAuth state${errorDetail}`);
      return;
    }
    await oauthStateStore.delete(state);

    const {
      providerId,
      codeVerifier: storedCodeVerifier,
      intent,
      linkUserId,
      userId: stateUserId,
      returnTo,
    } = stateEntry;

    const { getAllProviders } = await import("dofek/providers/registry");
    const { ensureProvidersRegistered } = await import("../../routers/sync.ts");
    await ensureProvidersRegistered();

    const provider = getAllProviders().find((p) => p.id === providerId);
    if (!provider) {
      res.status(404).send("Unknown provider");
      return;
    }

    const setup = provider.authSetup?.({ host: req.get("host") });
    if (!setup?.oauthConfig || !setup.exchangeCode) {
      res.status(400).send("Provider does not support OAuth code exchange");
      return;
    }

    // Revoke existing tokens before exchange — some providers (e.g. Wahoo) limit
    // the number of active tokens per app+user and reject new token creation until
    // old tokens are revoked.
    if (setup.oauthConfig.revokeUrl) {
      try {
        const { loadTokens } = await import("dofek/db/tokens");
        const existingTokens = await loadTokens(db, providerId, stateUserId);
        if (existingTokens?.accessToken) {
          logger.info(`[auth] Revoking existing ${providerId} access token before exchange...`);
          await revokeToken(setup.oauthConfig, existingTokens.accessToken);
        }
        if (existingTokens?.refreshToken) {
          logger.info(`[auth] Revoking existing ${providerId} refresh token before exchange...`);
          await revokeToken(setup.oauthConfig, existingTokens.refreshToken);
        }
      } catch (revokeError) {
        logger.warn(
          `[auth] Pre-exchange token revocation failed for ${providerId}: ${revokeError}`,
        );
        Sentry.captureException(revokeError);
      }
    }

    logger.info(`[auth] Exchanging code for ${providerId} tokens...`);
    const tokens = await setup.exchangeCode(code, storedCodeVerifier);

    // Auto-link identity when connecting data providers (if getUserIdentity is available)
    if (setup.getUserIdentity && intent !== "data") {
      const identity = await setup.getUserIdentity(tokens.accessToken);

      if (intent === "login") {
        try {
          const { userId } = await resolveOrCreateUser(db, providerId, identity, undefined, {
            requireEmailForNewUser: setup.identityCapabilities?.providesEmail === false,
          });
          await persistProviderConnection({
            db,
            provider,
            providerName: provider.name,
            apiBaseUrl: setup.apiBaseUrl,
            tokens,
            userId,
          });
          const sessionInfo = await createSession(db, userId);

          // Mobile: redirect to app via deep link with session token
          if (stateEntry.mobileScheme && isValidMobileScheme(stateEntry.mobileScheme)) {
            logger.info(`[auth] User ${userId} logged in via data provider ${providerId} (mobile)`);
            res.redirect(
              `${stateEntry.mobileScheme}://auth/callback?session=${sessionInfo.sessionId}`,
            );
            return;
          }

          setSessionCookie(res, sessionInfo.sessionId, sessionInfo.expiresAt);
          logger.info(`[auth] User ${userId} logged in via data provider ${providerId}`);
          res.redirect(sanitizeReturnTo(returnTo) ?? "/");
          return;
        } catch (loginErr: unknown) {
          if (loginErr instanceof MissingEmailForSignupError) {
            const token = storePendingEmailSignup({
              providerId,
              providerName: provider.name,
              apiBaseUrl: setup.apiBaseUrl,
              identity: {
                providerAccountId: identity.providerAccountId,
                email: null,
                name: identity.name,
              },
              tokens,
              mobileScheme: stateEntry.mobileScheme,
              returnTo,
            });
            res.status(200).send(completeSignupHtml(provider.name, token));
            return;
          }
          throw loginErr;
        }
      }

      if (linkUserId) {
        await resolveOrCreateUser(db, providerId, identity, linkUserId);
        await persistProviderConnection({
          db,
          provider,
          providerName: provider.name,
          apiBaseUrl: setup.apiBaseUrl,
          tokens,
          userId: linkUserId,
        });
        logger.info(`[auth] Linked ${providerId} to user ${linkUserId}`);
        res.redirect("/settings");
        return;
      }
    } else if (setup.getUserIdentity) {
      await persistProviderConnection({
        db,
        provider,
        providerName: provider.name,
        apiBaseUrl: setup.apiBaseUrl,
        tokens,
        userId: stateUserId,
      });
      try {
        const identity = await setup.getUserIdentity(tokens.accessToken);
        const sessionId = getSessionIdFromRequest(req);
        const session = sessionId ? await validateSession(db, sessionId) : null;
        if (session) {
          await resolveOrCreateUser(db, providerId, identity, session.userId);
          logger.info(`[auth] Auto-linked ${providerId} identity to user ${session.userId}`);
        }
      } catch (identityErr: unknown) {
        logger.warn(`[auth] Failed to extract identity from ${providerId}: ${identityErr}`);
      }
    } else {
      await persistProviderConnection({
        db,
        provider,
        providerName: provider.name,
        apiBaseUrl: setup.apiBaseUrl,
        tokens,
        userId: stateUserId,
      });
    }

    res.send(
      oauthSuccessHtml(
        provider.name,
        `Token expires: ${tokens.expiresAt.toISOString()}`,
        provider.id,
      ),
    );
  } catch (err: unknown) {
    Sentry.captureException(err);
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`[auth] OAuth callback failed: ${message}`, { err });
    res.status(500).send("Token exchange failed — please try again");
  }
}
