import { randomBytes } from "node:crypto";
import { IDENTITY_PROVIDER_NAMES } from "@dofek/auth/auth";
import { getOAuthRedirectUri, type TokenSet } from "dofek/auth/oauth";
import { DEFAULT_USER_ID } from "dofek/db/schema";
import { sql } from "drizzle-orm";
import express, { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { MissingEmailForSignupError, resolveOrCreateUser } from "../auth/account-linking.ts";
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
  returnTo?: string;
}

const oauthStateMap = new Map<string, OAuthStateEntry>();
// OAuth 1.0 request token secrets (keyed by oauth_token)
const oauth1Secrets = new Map<
  string,
  { providerId: string; tokenSecret: string; userId: string }
>();

/**
 * Server-side state store for identity provider OAuth flows.
 * Cookies (SameSite=Lax) aren't sent on cross-site POST requests, which
 * breaks Apple Sign In (response_mode=form_post). This map provides a
 * fallback when cookies are unavailable.
 */
interface IdentityFlowEntry {
  codeVerifier: string;
  linkUserId?: string;
  mobileScheme?: string;
  returnTo?: string;
}
const identityFlowMap = new Map<string, IdentityFlowEntry>();

interface PendingEmailSignupEntry {
  providerId: string;
  providerName: string;
  apiBaseUrl?: string;
  identity: {
    providerAccountId: string;
    email: null;
    name: string | null;
  };
  tokens: TokenSet;
  mobileScheme?: string;
  returnTo?: string;
}

const pendingEmailSignupMap = new Map<string, PendingEmailSignupEntry>();

function storeIdentityFlow(state: string, entry: IdentityFlowEntry): void {
  identityFlowMap.set(state, entry);
  setTimeout(() => identityFlowMap.delete(state), 10 * 60 * 1000);
}

function storePendingEmailSignup(entry: PendingEmailSignupEntry): string {
  const token = randomBytes(16).toString("hex");
  pendingEmailSignupMap.set(token, entry);
  setTimeout(() => pendingEmailSignupMap.delete(token), 10 * 60 * 1000);
  return token;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function sanitizeReturnTo(returnTo: string | undefined): string | undefined {
  if (!returnTo) return undefined;
  if (!returnTo.startsWith("/") || returnTo.startsWith("//")) return undefined;
  return returnTo;
}

function completeSignupHtml(
  providerName: string,
  token: string,
  email = "",
  error?: string,
): string {
  const escapedProviderName = escapeHtml(providerName);
  const escapedToken = escapeHtml(token);
  const escapedEmail = escapeHtml(email);
  const errorHtml = error
    ? `<p style="margin:0 0 16px;color:#fca5a5;font-size:14px">${escapeHtml(error)}</p>`
    : "";
  return `<html><body style="font-family:system-ui;background:#111827;color:#f9fafb;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px"><div style="width:100%;max-width:420px;background:#1f2937;border:1px solid #374151;border-radius:16px;padding:32px;box-sizing:border-box"><h1 style="margin:0 0 12px;font-size:28px">Enter your email to finish signing in</h1><p style="margin:0 0 20px;color:#d1d5db;line-height:1.5">${escapedProviderName} does not provide your email address, so we need it before creating your account.</p>${errorHtml}<form method="post" action="/auth/complete-signup" style="display:flex;flex-direction:column;gap:16px"><input type="hidden" name="token" value="${escapedToken}" /><label style="display:flex;flex-direction:column;gap:8px;font-size:14px;color:#e5e7eb"><span>Email</span><input type="email" name="email" value="${escapedEmail}" autocomplete="email" required style="border:1px solid #4b5563;border-radius:10px;padding:12px 14px;background:#111827;color:#f9fafb;font-size:16px" /></label><button type="submit" style="border:0;border-radius:10px;padding:12px 16px;background:#10b981;color:#06281f;font-size:16px;font-weight:700;cursor:pointer">Continue</button></form></div></body></html>`;
}

async function persistProviderConnection(params: {
  db: import("dofek/db").Database;
  provider: import("dofek/providers/types").Provider;
  providerName: string;
  apiBaseUrl?: string;
  tokens: TokenSet;
  userId: string;
}): Promise<void> {
  const { ensureProvider, saveTokens } = await import("dofek/db/tokens");
  await ensureProvider(
    params.db,
    params.provider.id,
    params.providerName,
    params.apiBaseUrl,
    params.userId,
  );
  await saveTokens(params.db, params.provider.id, params.tokens);
  await queryCache.invalidateByPrefix(`${params.userId}:sync.providers`);

  logger.info(
    `[auth] ${params.provider.id} tokens saved for user ${params.userId}. Expires: ${params.tokens.expiresAt.toISOString()}`,
  );

  try {
    const { isWebhookProvider } = await import("dofek/providers/types");
    if (isWebhookProvider(params.provider)) {
      const { registerWebhookForProvider } = await import("./webhooks.ts");
      await registerWebhookForProvider(params.db, params.provider);
      logger.info(`[auth] Webhook registered for ${params.provider.id}`);
    }
  } catch (webhookErr: unknown) {
    logger.warn(`[auth] Failed to register webhook for ${params.provider.id}: ${webhookErr}`);
  }
}

function isIdentityProviderName(value: string): value is IdentityProviderName {
  return IDENTITY_PROVIDER_NAMES.some((p) => p === value);
}

function getSinglePathParam(value: string | string[] | undefined): string | null {
  return typeof value === "string" ? value : null;
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
  req: import("express").Request,
  res: import("express").Response,
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

  // OAuth 1.0 providers (e.g. FatSecret) — only for data intent
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

// Module-level db reference, set during router creation
let db: import("dofek/db").Database;

// Rate limiter for auth endpoints (login, callback, native sign-in)
const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 30, // 30 attempts per window per IP
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: "Too many authentication attempts — please try again later",
});

export function createAuthRouter(database: import("dofek/db").Database): Router {
  db = database;
  const router = Router();

  router.get("/api/auth/providers", async (req, res) => {
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
  });

  router.get("/auth/login/:provider", (req, res) => {
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
  });

  // ── Link route: add a new identity provider to an existing logged-in account ──
  router.get("/auth/link/:provider", async (req, res) => {
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

      // Server-side fallback (same reason as login handler above)
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
  });

  /**
   * Shared handler for identity provider OAuth callbacks.
   * Accepts code/state/error from either query params (GET) or form body (POST).
   * Apple Sign In uses response_mode=form_post, so the callback comes as a POST
   * where SameSite=Lax cookies are not sent. Falls back to server-side state map.
   */
  async function handleIdentityCallback(
    req: import("express").Request<{ provider: string }>,
    res: import("express").Response,
  ) {
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

      // Try cookies first (works for GET redirects from Google/Authentik)
      const cookieFlow = getOAuthFlowCookies(req);
      let storedState = cookieFlow.state;
      let codeVerifier = cookieFlow.codeVerifier;
      let linkUserId = getLinkUserCookie(req);
      let mobileScheme = getMobileSchemeCookie(req);
      let returnTo = getPostLoginRedirectCookie(req);
      clearOAuthFlowCookies(res);

      // Fall back to server-side map when cookies are unavailable
      // (Apple form_post: SameSite=Lax cookies aren't sent on cross-site POST)
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
  }

  router.get("/auth/callback/:provider", authRateLimiter, handleIdentityCallback);
  // Apple Sign In uses response_mode=form_post, sending code/state as POST body
  router.post(
    "/auth/callback/:provider",
    authRateLimiter,
    express.urlencoded({ extended: false }),
    handleIdentityCallback,
  );

  // ── Native Apple Sign In (iOS) ──
  // iOS uses ASAuthorizationController which returns an authorization code + identity token directly.
  // This endpoint exchanges the code for tokens and creates a session.
  router.post(
    "/auth/apple/native",
    authRateLimiter,
    express.urlencoded({ extended: false }),
    express.json(),
    async (req, res) => {
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

        // Apple only provides name on first sign-in; the native SDK returns it separately
        const givenName = typeof req.body.givenName === "string" ? req.body.givenName : undefined;
        const familyName =
          typeof req.body.familyName === "string" ? req.body.familyName : undefined;
        const fullName = [givenName, familyName].filter(Boolean).join(" ") || null;

        const provider = getIdentityProvider("apple");
        // Apple doesn't use PKCE, so pass empty string as codeVerifier
        const { user: identityUser } = await provider.validateCallback(authorizationCode, "");

        // Use the name from the native SDK if the identity token didn't include it
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
  );

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
  router.get("/auth/provider/slack", authRateLimiter, async (req, res) => {
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
        userId: DEFAULT_USER_ID,
        mobileScheme,
        returnTo,
      });
    } catch (err: unknown) {
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
  });

  // ── Data-provider OAuth for data sync (Wahoo, Withings, etc.) ──
  router.get("/auth/provider/:provider", authRateLimiter, async (req, res) => {
    try {
      const providerId = getSinglePathParam(req.params.provider);
      if (!providerId) {
        res.status(400).send("Missing provider");
        return;
      }
      // Resolve the logged-in user so the provider record is linked to them
      const sessionId = getSessionIdFromRequest(req);
      const session = sessionId ? await validateSession(db, sessionId) : null;
      const userId = session?.userId ?? DEFAULT_USER_ID;

      await startDataProviderOAuth(req, res, providerId, {
        providerId,
        intent: "data",
        userId,
      });
    } catch (err: unknown) {
      logger.error(`[auth] Failed to start OAuth flow: ${err}`);
      res.status(500).send("Auth error: failed to start OAuth flow");
    }
  });

  router.get("/callback", authRateLimiter, async (req, res) => {
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
          res.status(400).send("Slack OAuth failed");
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
          // Non-fatal: identity extraction failed but tokens are saved
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
  });

  router.post(
    "/auth/complete-signup",
    express.urlencoded({ extended: false }),
    async (req, res) => {
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
  );

  return router;
}
