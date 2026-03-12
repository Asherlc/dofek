import type { Request, Response } from "express";

const SESSION_COOKIE = "session";
const CODE_VERIFIER_COOKIE = "auth_code_verifier";
const STATE_COOKIE = "auth_state";

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
  return req.cookies?.[SESSION_COOKIE] as string | undefined;
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
  return {
    state: req.cookies?.[STATE_COOKIE] as string | undefined,
    codeVerifier: req.cookies?.[CODE_VERIFIER_COOKIE] as string | undefined,
  };
}

export function clearOAuthFlowCookies(res: Response): void {
  res.clearCookie(STATE_COOKIE, { path: "/" });
  res.clearCookie(CODE_VERIFIER_COOKIE, { path: "/" });
}
