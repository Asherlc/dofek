import { randomBytes } from "node:crypto";
import { IDENTITY_PROVIDER_NAMES } from "@dofek/auth/auth";
import { getOAuthRedirectUri } from "dofek/auth/oauth";
import { DEFAULT_USER_ID } from "dofek/db/schema";
import { sql } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import { resolveOrCreateUser } from "../auth/account-linking.ts";
import {
  clearOAuthFlowCookies,
  clearSessionCookie,
  getLinkUserCookie,
  getMobileSchemeCookie,
  getOAuthFlowCookies,
  getPostLoginRedirectCookie,
  getSessionIdFromRequest,
  isValidMobileScheme,
  setLinkUserCookie,
  setMobileSchemeCookie,
  setOAuthFlowCookies,
  setPostLoginRedirectCookie,
  setSessionCookie,
} from "../auth/cookies.ts";
import {
  generateCodeVerifier,
  generateState,
  getConfiguredProviders,
  getIdentityProvider,
  type IdentityProviderName,
  isProviderConfigured,
} from "../auth/providers.ts";
import { createSession, deleteSession, validateSession } from "../auth/session.ts";
import { queryCache } from "../lib/cache.ts";
import { executeWithSchema } from "../lib/typed-sql.ts";
import { logger } from "../logger.ts";

/**
 * Build the HTML page shown in the OAuth popup after successful authorization.
 * Includes a BroadcastChannel message + window.close() so the parent window
 * detects the completion and refreshes provider status automatically.
 */
export function oauthSuccessHtml(
  providerName: string,
  detail?: string,
  providerId?: string,
): string {
  const detailLine = detail ? `<p>${detail}</p>` : "";
  const broadcastPayload = JSON.stringify({ type: "complete", providerId });
  const postMessagePayload = JSON.stringify({ type: "oauth-complete", providerId });
  return `<html><body style="font-family:system-ui;background:#111;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><h1>Authorized!</h1><p>${providerName} connected successfully.</p>${detailLine}<p><a href="/" style="color:#10b981">Return to dashboard</a></p></div><script>try{new BroadcastChannel('oauth-complete').postMessage(${broadcastPayload})}catch(e){}try{window.opener&&window.opener.postMessage(${postMessagePayload},'*')}catch(e){}setTimeout(function(){window.close()},1500)</script></body></html>`;
}

interface OAuthStateEntry {
  providerId: string;
  codeVerifier?: string;
  intent: "data" | "login" | "link";
  linkUserId?: string;
  userId: string;
  /** Mobile app URL scheme for deep link redirect after OAuth. */
  mobileScheme?: string;
}

const oauthStateMap = new Map<string, OAuthStateEntry>();
// OAuth 1.0 request token secrets (keyed by oauth_token)
const oauth1Secrets = new Map<
  string,
  { providerId: string; tokenSecret: string; userId: string }
>();

function isIdentityProviderName(value: string): value is IdentityProviderName {
  return IDENTITY_PROVIDER_NAMES.some((p) => p === value);
}

const SLACK_SCOPES = [
  "chat:write",
  "im:history",
  "im:read",
  "im:write",
  "users:read",
  "users:read.email",
];

async function startDataProviderOAuth(
  res: import("express").Response,
  providerId: string,
  stateEntry: OAuthStateEntry,
): Promise<void> {
  const { getAllProviders } = await import("dofek/providers/registry");
  const { ensureProvidersRegistered } = await import("../routers/sync.ts");
  await ensureProvidersRegistered();

  const provider = getAllProviders().find((p) => p.id === providerId);
  if (!provider) {
    res.status(404).send(`Unknown provider: ${providerId}`);
    return;
  }

  const setup = provider.authSetup?.();
  if (!setup?.oauthConfig) {
    res.status(400).send(`Provider ${providerId} does not use OAuth`);
    return;
  }

  // Login intent requires getUserIdentity to extract user info from the provider
  if (stateEntry.intent === "login" && !setup.getUserIdentity) {
    res.status(400).send(`Provider ${providerId} cannot be used for login`);
    return;
  }

  // Credential providers use the generic credentialAuth.signIn tRPC endpoint instead
  if (setup.automatedLogin && stateEntry.intent === "data") {
    res
      .status(400)
      .send(
        `Provider ${providerId} uses credential authentication — sign in via the Settings page`,
      );
    return;
  }

  // OAuth 1.0 providers (e.g. FatSecret) — only for data intent
  if (setup.oauth1Flow && stateEntry.intent === "data") {
    const callbackUrl = `${process.env.OAUTH_REDIRECT_URI ?? "https://dofek.asherlc.com/callback"}`;
    const result = await setup.oauth1Flow.getRequestToken(callbackUrl);
    oauth1Secrets.set(result.oauthToken, {
      providerId,
      tokenSecret: result.oauthTokenSecret,
      userId: stateEntry.userId,
    });
    setTimeout(() => oauth1Secrets.delete(result.oauthToken), 10 * 60 * 1000);
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

  const url = buildAuthorizationUrl(setup.oauthConfig, pkceParam);
  const stateToken = randomBytes(16).toString("hex");
  oauthStateMap.set(stateToken, { ...stateEntry, codeVerifier: pkceVerifier });
  setTimeout(() => oauthStateMap.delete(stateToken), 10 * 60 * 1000);
  const authUrl = new URL(url);
  authUrl.searchParams.set("state", stateToken);
  res.redirect(authUrl.toString());
}

// Module-level db reference, set during router creation
let db: import("dofek/db").Database;

export function createAuthRouter(database: import("dofek/db").Database): Router {
  db = database;
  const router = Router();

  router.get("/api/auth/providers", async (_req, res) => {
    try {
      const identityProviders = getConfiguredProviders();
      const { getAllProviders } = await import("dofek/providers/registry");
      const { ensureProvidersRegistered } = await import("../routers/sync.ts");
      await ensureProvidersRegistered();

      const dataLoginProviders = getAllProviders()
        .filter((p) => {
          try {
            const setup = p.authSetup?.();
            return setup?.getUserIdentity && setup.oauthConfig;
          } catch (err: unknown) {
            logger.warn(`[auth] Skipping ${p.id} for login: authSetup() threw: ${err}`);
            return false;
          }
        })
        .map((p) => p.id);

      res.json({ identity: identityProviders, data: dataLoginProviders });
    } catch (err: unknown) {
      logger.error(`[auth] Failed to list providers: ${err}`);
      res.json({ identity: getConfiguredProviders(), data: [] });
    }
  });

  router.get("/auth/login/:provider", (req, res) => {
    try {
      const providerNameRaw = req.params.provider;
      if (!isIdentityProviderName(providerNameRaw)) {
        res.status(404).send(`Unknown identity provider: ${providerNameRaw}`);
        return;
      }
      const providerName = providerNameRaw;
      if (!isProviderConfigured(providerName)) {
        res.status(400).send(`Provider ${providerName} is not configured`);
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

      setPostLoginRedirectCookie(
        res,
        typeof req.query.return_to === "string" ? req.query.return_to : undefined,
      );

      res.redirect(url.toString());
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[auth] Failed to start login flow: ${message}`);
      res.status(500).send("Auth error: failed to start login flow");
    }
  });

  // ── Link route: add a new identity provider to an existing logged-in account ──
  router.get("/auth/link/:provider", async (req, res) => {
    try {
      const providerNameRaw = req.params.provider;
      if (!isIdentityProviderName(providerNameRaw)) {
        res.status(404).send(`Unknown identity provider: ${providerNameRaw}`);
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
      const session = await validateSession(db, sessionId);
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
      res.redirect(url.toString());
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[auth] Failed to start link flow: ${message}`);
      res.status(500).send("Auth error: failed to start link flow");
    }
  });

  router.get("/auth/callback/:provider", async (req, res) => {
    try {
      const providerNameRaw = req.params.provider;
      if (!isIdentityProviderName(providerNameRaw)) {
        res.status(404).send(`Unknown identity provider: ${providerNameRaw}`);
        return;
      }
      const providerName = providerNameRaw;

      const code = typeof req.query.code === "string" ? req.query.code : undefined;
      const stateParam = typeof req.query.state === "string" ? req.query.state : undefined;
      const error = typeof req.query.error === "string" ? req.query.error : undefined;

      if (error) {
        res.status(400).send(`Authorization denied: ${error}`);
        return;
      }
      if (!code || !stateParam) {
        res.status(400).send("Missing code or state parameter");
        return;
      }

      const { state: storedState, codeVerifier } = getOAuthFlowCookies(req);
      const linkUserId = getLinkUserCookie(req);
      const mobileScheme = getMobileSchemeCookie(req);
      const returnTo = getPostLoginRedirectCookie(req);
      clearOAuthFlowCookies(res);

      if (!storedState || !codeVerifier || stateParam !== storedState) {
        res.status(400).send("Invalid state — please try logging in again");
        return;
      }

      // Validate the authorization code
      const provider = getIdentityProvider(providerName);
      const { user: identityUser } = await provider.validateCallback(code, codeVerifier);

      // Resolve or create user (with email-based auto-linking and optional logged-in linking)
      const { userId } = await resolveOrCreateUser(
        db,
        providerName,
        {
          providerAccountId: identityUser.sub,
          email: identityUser.email,
          name: identityUser.name,
          groups: identityUser.groups,
        },
        linkUserId,
      );

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

      logger.info(
        `[auth] User ${userId} ${linkUserId ? "linked" : "logged in via"} ${providerName}`,
      );
      res.redirect(linkUserId ? "/settings" : (returnTo ?? "/"));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[auth] Identity callback failed: ${message}`);
      res.status(500).send("Login failed — please try again");
    }
  });

  router.post("/auth/logout", async (req, res) => {
    const sessionId = getSessionIdFromRequest(req);
    if (sessionId) {
      await deleteSession(db, sessionId);
      clearSessionCookie(res);
    }
    res.json({ ok: true });
  });

  router.get("/api/auth/me", async (req, res) => {
    const sessionId = getSessionIdFromRequest(req);
    if (!sessionId) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }
    const session = await validateSession(db, sessionId);
    if (!session) {
      clearSessionCookie(res);
      res.status(401).json({ error: "Session expired" });
      return;
    }
    const rows = await executeWithSchema(
      db,
      z.object({
        id: z.string(),
        name: z.string(),
        email: z.string().nullable(),
        is_admin: z.boolean(),
      }),
      sql`SELECT id, name, email, is_admin FROM fitness.user_profile WHERE id = ${session.userId}`,
    );
    if (rows.length === 0) {
      res.status(401).json({ error: "User not found" });
      return;
    }
    const userAgent = req.headers["user-agent"] ?? "unknown";
    const isMobile = userAgent.includes("Darwin") || userAgent.includes("CFNetwork");
    if (isMobile) {
      logger.info(`[auth] /me resolved userId=${session.userId} (mobile)`);
    }
    const row = rows[0];
    if (!row) {
      res.status(401).json({ error: "User not found" });
      return;
    }
    res.json({ id: row.id, name: row.name, email: row.email, isAdmin: row.is_admin });
  });

  // ── Slack OAuth (Add to Slack) ──
  router.get("/auth/provider/slack", async (req, res) => {
    const clientId = process.env.SLACK_CLIENT_ID;
    if (!clientId) {
      res.status(400).send("SLACK_CLIENT_ID is not configured");
      return;
    }

    // Resolve the logged-in user so we can link the Slack identity to them
    const sessionId = getSessionIdFromRequest(req);
    const session = sessionId ? await validateSession(db, sessionId) : null;
    const userId = session?.userId ?? DEFAULT_USER_ID;

    const redirectUri = getOAuthRedirectUri();
    const stateToken = `slack:${randomBytes(16).toString("hex")}`;
    oauthStateMap.set(stateToken, {
      providerId: "slack",
      intent: "data",
      userId,
    });
    setTimeout(() => oauthStateMap.delete(stateToken), 10 * 60 * 1000);
    const url = new URL("https://slack.com/oauth/v2/authorize");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("scope", SLACK_SCOPES.join(","));
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", stateToken);
    res.redirect(url.toString());
  });

  // ── Data provider login: use a data provider as an identity/login provider ──
  router.get("/auth/login/data/:provider", async (req, res) => {
    try {
      const redirectScheme =
        typeof req.query.redirect_scheme === "string" ? req.query.redirect_scheme : undefined;
      const mobileScheme =
        redirectScheme && isValidMobileScheme(redirectScheme) ? redirectScheme : undefined;
      await startDataProviderOAuth(res, req.params.provider, {
        providerId: req.params.provider,
        intent: "login",
        userId: DEFAULT_USER_ID,
        mobileScheme,
      });
    } catch (err: unknown) {
      logger.error(`[auth] Failed to start data provider login: ${err}`);
      res.status(500).send("Auth error: failed to start login flow");
    }
  });

  // ── Data provider link: link a data provider as identity while already logged in ──
  router.get("/auth/link/data/:provider", async (req, res) => {
    try {
      const sessionId = getSessionIdFromRequest(req);
      if (!sessionId) {
        res.status(401).send("You must be logged in to link an account");
        return;
      }
      const session = await validateSession(db, sessionId);
      if (!session) {
        res.status(401).send("Session expired — please log in first");
        return;
      }

      await startDataProviderOAuth(res, req.params.provider, {
        providerId: req.params.provider,
        intent: "link",
        linkUserId: session.userId,
        userId: session.userId,
      });
    } catch (err: unknown) {
      logger.error(`[auth] Failed to start data provider link: ${err}`);
      res.status(500).send("Auth error: failed to start link flow");
    }
  });

  // ── Data-provider OAuth for data sync (Wahoo, Withings, etc.) ──
  router.get("/auth/provider/:provider", async (req, res) => {
    try {
      // Resolve the logged-in user so the provider record is linked to them
      const sessionId = getSessionIdFromRequest(req);
      const session = sessionId ? await validateSession(db, sessionId) : null;
      const userId = session?.userId ?? DEFAULT_USER_ID;

      await startDataProviderOAuth(res, req.params.provider, {
        providerId: req.params.provider,
        intent: "data",
        userId,
      });
    } catch (err: unknown) {
      logger.error(`[auth] Failed to start OAuth flow: ${err}`);
      res.status(500).send("Auth error: failed to start OAuth flow");
    }
  });

  router.get("/callback", async (req, res) => {
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
        res.status(400).send(`Authorization denied: ${error}`);
        return;
      }

      // ── OAuth 1.0 callback (FatSecret) ──
      if (oauthToken && oauthVerifier) {
        const stored = oauth1Secrets.get(oauthToken);
        if (!stored) {
          res.status(400).send("Unknown or expired OAuth 1.0 request token");
          return;
        }
        oauth1Secrets.delete(oauthToken);

        const { getAllProviders } = await import("dofek/providers/registry");
        const { ensureProvidersRegistered } = await import("../routers/sync.ts");
        await ensureProvidersRegistered();

        const provider = getAllProviders().find((p) => p.id === stored.providerId);
        if (!provider) {
          res.status(404).send(`Unknown provider: ${stored.providerId}`);
          return;
        }

        const setup = provider.authSetup?.();
        if (!setup?.oauth1Flow) {
          res.status(400).send(`Provider ${stored.providerId} does not support OAuth 1.0`);
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
        await saveTokens(db, provider.id, {
          accessToken: token,
          refreshToken: tokenSecret,
          expiresAt: new Date("2099-12-31"),
          scopes: "",
        });
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
      if (state.startsWith("slack:") && oauthStateMap.has(state)) {
        const slackState = oauthStateMap.get(state);
        oauthStateMap.delete(state);
        const clientId = process.env.SLACK_CLIENT_ID;
        const clientSecret = process.env.SLACK_CLIENT_SECRET;
        if (!clientId || !clientSecret) {
          res.status(400).send("SLACK_CLIENT_ID and SLACK_CLIENT_SECRET must be set");
          return;
        }

        const redirectUri = getOAuthRedirectUri();
        logger.info("[auth] Exchanging Slack OAuth code for bot token...");

        // Exchange code for access token via Slack's oauth.v2.access
        const tokenResponse = await fetch("https://slack.com/api/oauth.v2.access", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            code,
            redirect_uri: redirectUri,
          }),
        });
        const tokenData: {
          ok: boolean;
          error?: string;
          team?: { id: string; name: string };
          access_token?: string;
          bot_user_id?: string;
          app_id?: string;
          authed_user?: { id: string };
        } = await tokenResponse.json();

        if (!tokenData.ok || !tokenData.access_token || !tokenData.team?.id) {
          res.status(400).send(`Slack OAuth failed: ${tokenData.error ?? "unknown error"}`);
          return;
        }

        // Store the installation
        await db.execute(
          sql`INSERT INTO fitness.slack_installation (
                team_id, team_name, bot_token, bot_user_id, app_id,
                installer_slack_user_id, raw_installation
              ) VALUES (
                ${tokenData.team.id},
                ${tokenData.team.name ?? null},
                ${tokenData.access_token},
                ${tokenData.bot_user_id ?? null},
                ${tokenData.app_id ?? null},
                ${tokenData.authed_user?.id ?? null},
                ${JSON.stringify(tokenData)}::jsonb
              )
              ON CONFLICT (team_id) DO UPDATE SET
                team_name = EXCLUDED.team_name,
                bot_token = EXCLUDED.bot_token,
                bot_user_id = EXCLUDED.bot_user_id,
                app_id = EXCLUDED.app_id,
                installer_slack_user_id = EXCLUDED.installer_slack_user_id,
                raw_installation = EXCLUDED.raw_installation,
                updated_at = NOW()`,
        );

        // Link the installer's Slack identity to the logged-in dofek user
        // so the bot can immediately identify them when they send a message
        const installerSlackUserId = tokenData.authed_user?.id;
        if (installerSlackUserId && slackState) {
          // Check for existing orphaned auth_account pointing to wrong user
          const existingLink = await executeWithSchema(
            db,
            z.object({ user_id: z.string() }),
            sql`SELECT user_id FROM fitness.auth_account
                WHERE auth_provider = 'slack' AND provider_account_id = ${installerSlackUserId}
                LIMIT 1`,
          );
          const existingLinkRow = existingLink[0];
          const orphanUserId =
            existingLinkRow && existingLinkRow.user_id !== slackState.userId
              ? existingLinkRow.user_id
              : null;

          // Create or update the auth_account link
          await db.execute(
            sql`INSERT INTO fitness.auth_account (user_id, auth_provider, provider_account_id)
                VALUES (${slackState.userId}, 'slack', ${installerSlackUserId})
                ON CONFLICT (auth_provider, provider_account_id)
                DO UPDATE SET user_id = EXCLUDED.user_id`,
          );

          // Migrate food entries from orphan user if needed
          if (orphanUserId) {
            await db.execute(
              sql`UPDATE fitness.food_entry SET user_id = ${slackState.userId}
                  WHERE user_id = ${orphanUserId}`,
            );
            logger.info(
              `[auth] Migrated food entries from orphan ${orphanUserId} to ${slackState.userId}`,
            );
          }

          logger.info(
            `[auth] Linked Slack user ${installerSlackUserId} to dofek user ${slackState.userId}`,
          );
        }

        logger.info(
          `[auth] Slack installed for team ${tokenData.team.id} (${tokenData.team.name})`,
        );
        res.send(
          oauthSuccessHtml(
            "Slack",
            `Bot added to <strong>${tokenData.team.name}</strong>. Send me a DM about what you ate!`,
          ),
        );
        return;
      }

      // Resolve provider from random state token
      const stateEntry = oauthStateMap.get(state);
      if (!stateEntry) {
        res.status(400).send("Unknown or expired OAuth state");
        return;
      }
      oauthStateMap.delete(state);

      const {
        providerId,
        codeVerifier: storedCodeVerifier,
        intent,
        linkUserId,
        userId: stateUserId,
      } = stateEntry;

      const { getAllProviders } = await import("dofek/providers/registry");
      const { ensureProvidersRegistered } = await import("../routers/sync.ts");
      await ensureProvidersRegistered();

      const provider = getAllProviders().find((p) => p.id === providerId);
      if (!provider) {
        res.status(404).send(`Unknown provider: ${providerId}`);
        return;
      }

      const setup = provider.authSetup?.();
      if (!setup?.oauthConfig || !setup.exchangeCode) {
        res.status(400).send(`Provider ${providerId} does not support OAuth code exchange`);
        return;
      }

      logger.info(`[auth] Exchanging code for ${providerId} tokens...`);
      const tokens = await setup.exchangeCode(code, storedCodeVerifier);

      const { ensureProvider } = await import("dofek/db/tokens");
      const { saveTokens } = await import("dofek/db/tokens");
      await ensureProvider(db, provider.id, provider.name, setup.apiBaseUrl, stateUserId);
      await saveTokens(db, provider.id, tokens);
      await queryCache.invalidateByPrefix(`${stateUserId}:sync.providers`);

      logger.info(`[auth] ${providerId} tokens saved. Expires: ${tokens.expiresAt.toISOString()}`);

      // Register webhook subscription if this provider supports push notifications
      try {
        const { isWebhookProvider } = await import("dofek/providers/types");
        if (isWebhookProvider(provider)) {
          const { registerWebhookForProvider } = await import("./webhooks.ts");
          await registerWebhookForProvider(db, provider);
          logger.info(`[auth] Webhook registered for ${providerId}`);
        }
      } catch (webhookErr: unknown) {
        // Non-fatal: webhook registration failure shouldn't block provider connection
        logger.warn(`[auth] Failed to register webhook for ${providerId}: ${webhookErr}`);
      }

      // Auto-link identity when connecting data providers (if getUserIdentity is available)
      if (setup.getUserIdentity) {
        try {
          const identity = await setup.getUserIdentity(tokens.accessToken);

          if (intent === "login") {
            // Data provider login: resolve/create user and create session
            const { userId } = await resolveOrCreateUser(db, providerId, identity);
            const sessionInfo = await createSession(db, userId);

            // Mobile: redirect to app via deep link with session token
            if (stateEntry.mobileScheme && isValidMobileScheme(stateEntry.mobileScheme)) {
              logger.info(
                `[auth] User ${userId} logged in via data provider ${providerId} (mobile)`,
              );
              res.redirect(
                `${stateEntry.mobileScheme}://auth/callback?session=${sessionInfo.sessionId}`,
              );
              return;
            }

            setSessionCookie(res, sessionInfo.sessionId, sessionInfo.expiresAt);
            logger.info(`[auth] User ${userId} logged in via data provider ${providerId}`);
            res.redirect("/");
            return;
          }

          if (intent === "link" && linkUserId) {
            // Data provider link: link to logged-in user
            await resolveOrCreateUser(db, providerId, identity, linkUserId);
            logger.info(`[auth] Linked ${providerId} to user ${linkUserId}`);
            res.redirect("/settings");
            return;
          }

          // intent === "data": auto-link identity to the current session user (if logged in)
          const sessionId = getSessionIdFromRequest(req);
          const session = sessionId ? await validateSession(db, sessionId) : null;
          if (session) {
            await resolveOrCreateUser(db, providerId, identity, session.userId);
            logger.info(`[auth] Auto-linked ${providerId} identity to user ${session.userId}`);
          }
        } catch (identityErr: unknown) {
          // Non-fatal: identity extraction failed but tokens are saved
          logger.warn(`[auth] Failed to extract identity from ${providerId}: ${identityErr}`);
        }
      }

      res.send(
        oauthSuccessHtml(
          provider.name,
          `Token expires: ${tokens.expiresAt.toISOString()}`,
          provider.id,
        ),
      );
    } catch (err: unknown) {
      logger.error(`[auth] OAuth callback failed: ${err}`);
      res.status(500).send("Token exchange failed");
    }
  });

  return router;
}
