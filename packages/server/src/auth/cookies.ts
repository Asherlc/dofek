import type { Request, Response } from "express";

const SESSION_COOKIE = "session";
const CODE_VERIFIER_COOKIE = "auth_code_verifier";
const STATE_COOKIE = "auth_state";
const LINK_USER_COOKIE = "auth_link_user";
const MOBILE_SCHEME_COOKIE = "auth_mobile_scheme";
const POST_LOGIN_REDIRECT_COOKIE = "auth_post_login_redirect";

const isProduction = process.env.NODE_ENV === "production";

const cookieDefaults = {
  httpOnly: true,
  secure: isProduction,
  sameSite: "lax" as const,
  path: "/",
};

// ── Session cookie ──

export function setSessionCookie(res: Response, sessionId: string, expiresAt: Date): void {
  res.cookie(SESSION_COOKIE, sessionId, {
    ...cookieDefaults,
    expires: expiresAt,
  });
}

export function getSessionCookie(req: Request): string | undefined {
  const val = req.cookies?.[SESSION_COOKIE];
  return typeof val === "string" ? val : undefined;
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, { path: "/" });
}

// ── OAuth flow cookies (short-lived, for PKCE state) ──

const FLOW_MAX_AGE = 10 * 60 * 1000; // 10 minutes

export function setOAuthFlowCookies(res: Response, state: string, codeVerifier: string): void {
  res.cookie(STATE_COOKIE, state, { ...cookieDefaults, maxAge: FLOW_MAX_AGE });
  res.cookie(CODE_VERIFIER_COOKIE, codeVerifier, { ...cookieDefaults, maxAge: FLOW_MAX_AGE });
}

export function getOAuthFlowCookies(req: Request): {
  state: string | undefined;
  codeVerifier: string | undefined;
} {
  const state = req.cookies?.[STATE_COOKIE];
  const codeVerifier = req.cookies?.[CODE_VERIFIER_COOKIE];
  return {
    state: typeof state === "string" ? state : undefined,
    codeVerifier: typeof codeVerifier === "string" ? codeVerifier : undefined,
  };
}

export function clearOAuthFlowCookies(res: Response): void {
  res.clearCookie(STATE_COOKIE, { path: "/" });
  res.clearCookie(CODE_VERIFIER_COOKIE, { path: "/" });
  res.clearCookie(LINK_USER_COOKIE, { path: "/" });
  res.clearCookie(MOBILE_SCHEME_COOKIE, { path: "/" });
  res.clearCookie(POST_LOGIN_REDIRECT_COOKIE, { path: "/" });
}

// ── Account linking cookie (marks OAuth flow as "link to existing user") ──

export function setLinkUserCookie(res: Response, userId: string): void {
  res.cookie(LINK_USER_COOKIE, userId, { ...cookieDefaults, maxAge: FLOW_MAX_AGE });
}

export function getLinkUserCookie(req: Request): string | undefined {
  const val = req.cookies?.[LINK_USER_COOKIE];
  return typeof val === "string" ? val : undefined;
}

// ── Session from request (cookie or Authorization header) ──

/** Extract session ID from the session cookie, Authorization: Bearer header, or `session` query parameter.
 *  Priority: cookie > header > query param. Query param fallback supports mobile in-app browsers
 *  (e.g. SFSafariViewController) that cannot send cookies or custom headers. */
export function getSessionIdFromRequest(req: Request): string | undefined {
  const cookieSession = getSessionCookie(req);
  if (cookieSession) return cookieSession;

  const authHeader = req.headers?.authorization;
  if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    if (token.length > 0) return token;
  }

  const querySession = req.query?.session;
  if (typeof querySession === "string" && querySession.length > 0) return querySession;

  return undefined;
}

// ── Mobile redirect scheme cookie ──

/** Known mobile app URL schemes (allowlist for security). */
const ALLOWED_MOBILE_SCHEMES = ["dofek"];

/** Validate a redirect scheme against the allowlist. */
export function isValidMobileScheme(scheme: unknown): boolean {
  return typeof scheme === "string" && ALLOWED_MOBILE_SCHEMES.includes(scheme);
}

/** Store the mobile app's URL scheme during OAuth flow so the callback can redirect back. */
export function setMobileSchemeCookie(res: Response, scheme: string): void {
  res.cookie(MOBILE_SCHEME_COOKIE, scheme, { ...cookieDefaults, maxAge: FLOW_MAX_AGE });
}

export function getMobileSchemeCookie(req: Request): string | undefined {
  const val = req.cookies?.[MOBILE_SCHEME_COOKIE];
  return typeof val === "string" ? val : undefined;
}

// ── Post-login redirect cookie ──

function sanitizeReturnTo(returnTo: string | undefined): string | undefined {
  if (!returnTo) return undefined;
  if (!returnTo.startsWith("/") || returnTo.startsWith("//")) return undefined;
  return returnTo;
}

export function setPostLoginRedirectCookie(res: Response, returnTo: string | undefined): void {
  const sanitizedReturnTo = sanitizeReturnTo(returnTo);
  if (!sanitizedReturnTo) {
    clearPostLoginRedirectCookie(res);
    return;
  }
  res.cookie(POST_LOGIN_REDIRECT_COOKIE, sanitizedReturnTo, {
    ...cookieDefaults,
    maxAge: FLOW_MAX_AGE,
  });
}

export function getPostLoginRedirectCookie(req: Request): string | undefined {
  const val = req.cookies?.[POST_LOGIN_REDIRECT_COOKIE];
  return sanitizeReturnTo(typeof val === "string" ? val : undefined);
}

export function clearPostLoginRedirectCookie(res: Response): void {
  res.clearCookie(POST_LOGIN_REDIRECT_COOKIE, { path: "/" });
}
