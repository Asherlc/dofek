import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Request, Response } from "express";
import { z } from "zod";
import { MissingEmailForSignupError, resolveOrCreateUser } from "../../auth/account-linking.ts";
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
} from "../../auth/cookies.ts";
import {
  generateCodeVerifier,
  generateState,
  getConfiguredProviders,
  getIdentityProvider,
  type IdentityProviderName,
  isProviderConfigured,
} from "../../auth/providers.ts";
import { createSession, deleteSession, validateSession } from "../../auth/session.ts";
import { queryCache } from "../../lib/cache.ts";
import { executeWithSchema } from "../../lib/typed-sql.ts";
import { logger } from "../../logger.ts";
import {
  oauth1Secrets,
  oauthStateMap,
  identityFlowMap,
  pendingEmailSignupMap,
  storeIdentityFlow,
  storePendingEmailSignup,
} from "./state.ts";
import type { OAuthStateEntry } from "./types.ts";
import {
  completeSignupHtml,
  getSinglePathParam,
  isIdentityProviderName,
  oauthSuccessHtml,
  persistProviderConnection,
  sanitizeReturnTo,
} from "./utils.ts";
import { getOAuthRedirectUri } from "dofek/auth/oauth";

const SLACK_SCOPES = [
  "chat:write",
  "im:history",
  "im:read",
  "im:write",
  "users:read",
  "users:read.email",
];

async function startDataProviderOAuth(
  req: Request,
  res: Response,
  providerId: string,
  stateEntry: OAuthStateEntry,
): Promise<void> {
  const { getAllProviders } = await import("dofek/providers/registry");
  const { ensureProvidersRegistered } = await import("../routers/sync.ts");
  await ensureProvidersRegistered();

  const provider = getAllProviders().find((p) => p.id === providerId);
  if (!provider) {
    res.status(404).send("Unknown provider");
    return;
  }

  const host = req.get("host");
  const setup = provider.authSetup?.({ host });
  if (!setup?.oauthConfig) {
    res.status(400).send("Provider does not use OAuth");
    return;
  }

  if (stateEntry.intent === "login" && !setup.getUserIdentity) {
    res.status(400).send("Provider cannot be used for login");
    return;
  }

  if (setup.automatedLogin && stateEntry.intent === "data") {
    res
      .status(400)
      .send("Provider uses credential authentication and cannot be connected via OAuth here");
    return;
  }

  if (setup.oauth1Flow && stateEntry.intent === "data") {
    const callbackUrl = setup.oauthConfig.redirectUri;
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

export function createAuthHandlers(db: import("dofek/db").Database) {
  return {
    async listProviders(req: Request, res: Response) {
      try {
        const identityProviders = getConfiguredProviders();
        const { getAllProviders } = await import("dofek/providers/registry");
        const { ensureProvidersRegistered } = await import("../routers/sync.ts");
        await ensureProvidersRegistered();

        const dataLoginProviders = getAllProviders()
          .filter((p) => {
            try {
              const setup = p.authSetup?.({ host: req.get("host") });
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
    },

    startIdentityLogin(req: Request, res: Response) {
      try {
        const providerNameRaw = req.params.provider;
        if (!isIdentityProviderName(providerNameRaw)) {
          res.status(404).type("text/plain").send("Unknown identity provider");
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

        const statePayload = `${providerName}:${state}`;
        const url = provider.createAuthorizationUrl(statePayload, codeVerifier);

        setOAuthFlowCookies(res, statePayload, codeVerifier);

        const redirectScheme =
          typeof req.query.redirect_scheme === "string" ? req.query.redirect_scheme : undefined;
        if (redirectScheme && isValidMobileScheme(redirectScheme)) {
          setMobileSchemeCookie(res, redirectScheme);
        }

        const returnTo = typeof req.query.return_to === "string" ? req.query.return_to : undefined;
        setPostLoginRedirectCookie(res, returnTo);

        storeIdentityFlow(statePayload, {
          codeVerifier,
          mobileScheme:
            redirectScheme && isValidMobileScheme(redirectScheme) ? redirectScheme : undefined,
          returnTo,
        });

        res.redirect(url.toString());
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`[auth] Failed to start login flow: ${message}`);
        res.status(500).send("Auth error: failed to start login flow");
      }
    },

    async startIdentityLink(req: Request, res: Response) {
      try {
        const providerNameRaw = req.params.provider;
        if (!isIdentityProviderName(providerNameRaw)) {
          res.status(404).type("text/plain").send("Unknown identity provider");
          return;
        }
        const providerName = providerNameRaw;
        if (!isProviderConfigured(providerName)) {
          res.status(400).send(`Provider ${providerName} is not configured`);
          return;
        }

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

        storeIdentityFlow(statePayload, {
          codeVerifier,
          linkUserId: session.userId,
        });

        res.redirect(url.toString());
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`[auth] Failed to start link flow: ${message}`);
        res.status(500).send("Auth error: failed to start link flow");
      }
    },

    async handleIdentityCallback(req: Request<{ provider: string }>, res: Response) {
      try {
        const providerNameRaw = req.params.provider;
        if (!isIdentityProviderName(providerNameRaw)) {
          res.status(404).type("text/plain").send("Unknown identity provider");
          return;
        }
        const providerName = providerNameRaw;

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

        const cookieFlow = getOAuthFlowCookies(req);
        let storedState = cookieFlow.state;
        let codeVerifier = cookieFlow.codeVerifier;
        let linkUserId = getLinkUserCookie(req);
        let mobileScheme = getMobileSchemeCookie(req);
        let returnTo = getPostLoginRedirectCookie(req);
        clearOAuthFlowCookies(res);

        if (!storedState || !codeVerifier) {
          const flowEntry = identityFlowMap.get(stateParam);
          if (flowEntry) {
            storedState = stateParam;
            codeVerifier = flowEntry.codeVerifier;
            linkUserId = linkUserId ?? flowEntry.linkUserId;
            mobileScheme = mobileScheme ?? flowEntry.mobileScheme;
            returnTo = returnTo ?? flowEntry.returnTo;
            identityFlowMap.delete(stateParam);
          }
        }

        if (!storedState || !codeVerifier || stateParam !== storedState) {
          res.status(400).type("text/plain").send("Invalid state — please try logging in again");
          return;
        }

        const provider = getIdentityProvider(providerName);
        const { user: identityUser } = await provider.validateCallback(code, codeVerifier);

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

        if (!linkUserId) {
          const sessionInfo = await createSession(db, userId);

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
    },

    async handleNativeAppleSignIn(req: Request, res: Response) {
      try {
        if (!isProviderConfigured("apple")) {
          res.status(400).send("Apple Sign In is not configured");
          return;
        }

        const authorizationCode =
          typeof req.body.authorizationCode === "string" ? req.body.authorizationCode : undefined;
        if (!authorizationCode) {
          res.status(400).send("Missing authorizationCode");
          return;
        }

        const givenName = typeof req.body.givenName === "string" ? req.body.givenName : undefined;
        const familyName =
          typeof req.body.familyName === "string" ? req.body.familyName : undefined;
        const fullName = [givenName, familyName].filter(Boolean).join(" ") || null;

        const provider = getIdentityProvider("apple");
        const { user: identityUser } = await provider.validateCallback(authorizationCode, "");

        const userName = identityUser.name ?? fullName;

        const { userId } = await resolveOrCreateUser(db, "apple", {
          providerAccountId: identityUser.sub,
          email: identityUser.email,
          name: userName,
          groups: identityUser.groups,
        });

        const sessionInfo = await createSession(db, userId);
        logger.info(`[auth] User ${userId} logged in via native Apple Sign In`);
        res.json({ session: sessionInfo.sessionId });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`[auth] Native Apple Sign In failed: ${message}`);
        res.status(500).send("Apple Sign In failed — please try again");
      }
    },

    async logout(req: Request, res: Response) {
      const sessionId = getSessionIdFromRequest(req);
      if (sessionId) {
        await deleteSession(db, sessionId);
        clearSessionCookie(res);
      }
      res.json({ ok: true });
    },

    async getCurrentUser(req: Request, res: Response) {
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
    },

    async startSlackAuth(req: Request, res: Response) {
      const clientId = process.env.SLACK_CLIENT_ID;
      if (!clientId) {
        res.status(400).send("SLACK_CLIENT_ID is not configured");
        return;
      }

      const sessionId = getSessionIdFromRequest(req);
      const session = sessionId ? await validateSession(db, sessionId) : null;
      if (!session) {
        res.status(401).send("You must be logged in to connect Slack");
        return;
      }
      const userId = session.userId;

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
    },

    async startDataProviderLogin(req: Request, res: Response) {
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
        logger.error(`[auth] Failed to start data provider login: ${err}`);
        res.status(500).send("Auth error: failed to start login flow");
      }
    },

    async startDataProviderLink(req: Request, res: Response) {
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
        const session = await validateSession(db, sessionId);
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
        logger.error(`[auth] Failed to start data provider link: ${err}`);
        res.status(500).send("Auth error: failed to start link flow");
      }
    },

    async startDataProviderOAuthRoute(req: Request, res: Response) {
      try {
        const providerId = getSinglePathParam(req.params.provider);
        if (!providerId) {
          res.status(400).send("Missing provider");
          return;
        }

        const sessionId = getSessionIdFromRequest(req);
        const session = sessionId ? await validateSession(db, sessionId) : null;
        if (!session) {
          res.status(401).send("You must be logged in to connect a provider");
          return;
        }
        const userId = session.userId;

        const { getAllProviders } = await import("dofek/providers/registry");
        const { ensureProvidersRegistered } = await import("../routers/sync.ts");
        await ensureProvidersRegistered();
        const provider = getAllProviders().find((candidate) => candidate.id === providerId);
        if (!provider) {
          res.status(404).send("Unknown provider");
          return;
        }

        await startDataProviderOAuth(req, res, providerId, {
          providerId,
          intent: "data",
          userId,
        });
      } catch (err: unknown) {
        logger.error(`[auth] Failed to start OAuth flow: ${err}`);
        res.status(500).send("Auth error: failed to start OAuth flow");
      }
    },

    async handleOAuthCallback(req: Request, res: Response) {
      try {
        const code = typeof req.query.code === "string" ? req.query.code : undefined;
        const state = typeof req.query.state === "string" ? req.query.state : undefined;
        const error = typeof req.query.error === "string" ? req.query.error : undefined;
        const oauthToken =
          typeof req.query.oauth_token === "string" ? req.query.oauth_token : undefined;
        const oauthVerifier =
          typeof req.query.oauth_verifier === "string" ? req.query.oauth_verifier : undefined;

        if (!code && !state && !error && !oauthToken) {
          res.send("OK");
          return;
        }

        if (error) {
          res.status(400).type("text/plain").send("Authorization denied");
          return;
        }

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

        if (!code || !state) {
          res.status(400).send("Missing code or state parameter");
          return;
        }

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
            res.status(400).send("Slack OAuth failed");
            return;
          }

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

          const installerSlackUserId = tokenData.authed_user?.id;
          if (installerSlackUserId && slackState) {
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

            await db.execute(
              sql`INSERT INTO fitness.auth_account (user_id, auth_provider, provider_account_id)
                  VALUES (${slackState.userId}, 'slack', ${installerSlackUserId})
                  ON CONFLICT (auth_provider, provider_account_id)
                  DO UPDATE SET user_id = EXCLUDED.user_id`,
            );

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
              `Bot added to ${tokenData.team.name}. Send me a DM about what you ate!`,
            ),
          );
          return;
        }

        const stateEntry = oauthStateMap.get(state);
        if (!stateEntry) {
          const errorDetail = req.get("host")?.includes("localhost")
            ? " (Are you using an IP or host that differs from what the provider redirected to? Try setting OAUTH_REDIRECT_URI_unencrypted in your .env if testing on mobile.)"
            : "";
          res.status(400).send(`Unknown or expired OAuth state${errorDetail}`);
          return;
        }
        oauthStateMap.delete(state);

        const {
          providerId,
          codeVerifier: storedCodeVerifier,
          intent,
          linkUserId,
          userId: stateUserId,
          returnTo,
        } = stateEntry;

        const { getAllProviders } = await import("dofek/providers/registry");
        const { ensureProvidersRegistered } = await import("../routers/sync.ts");
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

        logger.info(`[auth] Exchanging code for ${providerId} tokens...`);
        const tokens = await setup.exchangeCode(code, storedCodeVerifier);

        if (setup.getUserIdentity && intent === "login") {
          const identity = await setup.getUserIdentity(tokens.accessToken);

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

            if (stateEntry.mobileScheme && isValidMobileScheme(stateEntry.mobileScheme)) {
              logger.info(`[auth] User ${userId} logged in via data provider ${providerId} (mobile)`);
              res.redirect(
                `${stateEntry.mobileScheme}://auth/callback?session=${sessionInfo.sessionId}`,
              );
              return;
            }

            setSessionCookie(res, sessionInfo.sessionId, sessionInfo.expiresAt);
            logger.info(`[auth] User ${userId} logged in via data provider ${providerId}`);
            res.redirect(returnTo ?? "/");
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

        if (setup.getUserIdentity && linkUserId) {
          const identity = await setup.getUserIdentity(tokens.accessToken);
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

        if (setup.getUserIdentity) {
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
        logger.error(`[auth] OAuth callback failed: ${err}`);
        res.status(500).send("Token exchange failed");
      }
    },

    async completeSignup(req: Request, res: Response) {
      try {
        const token = typeof req.body.token === "string" ? req.body.token : undefined;
        const rawEmail = typeof req.body.email === "string" ? req.body.email : "";
        if (!token) {
          res.status(400).type("text/plain").send("Missing signup token");
          return;
        }

        const pending = pendingEmailSignupMap.get(token);
        if (!pending) {
          res.status(400).type("text/plain").send("Signup session expired — please try again");
          return;
        }

        const parsedEmail = z.string().trim().email().safeParse(rawEmail);
        if (!parsedEmail.success) {
          res
            .status(400)
            .send(
              completeSignupHtml(
                pending.providerName,
                token,
                rawEmail,
                "Enter a valid email address.",
              ),
            );
          return;
        }

        const { userId } = await resolveOrCreateUser(db, pending.providerId, {
          providerAccountId: pending.identity.providerAccountId,
          email: parsedEmail.data,
          name: pending.identity.name,
        });
        const { getAllProviders } = await import("dofek/providers/registry");
        const provider = getAllProviders().find((candidate) => candidate.id === pending.providerId);
        if (!provider) {
          res.status(500).type("text/plain").send("Provider no longer available");
          return;
        }

        await persistProviderConnection({
          db,
          provider,
          providerName: pending.providerName,
          apiBaseUrl: pending.apiBaseUrl,
          tokens: pending.tokens,
          userId,
        });
        const sessionInfo = await createSession(db, userId);
        pendingEmailSignupMap.delete(token);

        if (pending.mobileScheme && isValidMobileScheme(pending.mobileScheme)) {
          logger.info(`[auth] User ${userId} completed signup via ${pending.providerId} (mobile)`);
          res.redirect(`${pending.mobileScheme}://auth/callback?session=${sessionInfo.sessionId}`);
          return;
        }

        setSessionCookie(res, sessionInfo.sessionId, sessionInfo.expiresAt);
        logger.info(`[auth] User ${userId} completed signup via ${pending.providerId}`);
        res.redirect(pending.returnTo ?? "/");
      } catch (err: unknown) {
        logger.error(`[auth] Completing signup failed: ${err}`);
        res.status(500).send("Signup failed — please try again");
      }
    },
  };
}
