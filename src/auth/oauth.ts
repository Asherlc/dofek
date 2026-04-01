import { createHash, randomBytes } from "node:crypto";

const DEFAULT_REDIRECT_URI = "https://dofek.asherlc.com/callback";

/**
 * Returns the OAuth redirect URI from OAUTH_REDIRECT_URI_unencrypted env var,
 * falling back to the production default. If a host is provided and the env var
 * is missing, it constructs a dynamic redirect URI based on that host.
 */
export function getOAuthRedirectUri(host?: string): string {
  const envValue = process.env.OAUTH_REDIRECT_URI_unencrypted ?? process.env.OAUTH_REDIRECT_URI;
  if (envValue) {
    return envValue;
  }
  if (host) {
    // Use http for local/private IPs, otherwise assume https
    const isLocal =
      host.includes("localhost") ||
      host.includes("127.0.0.1") ||
      host.startsWith("192.168.") ||
      host.startsWith("10.") ||
      host.startsWith("172.");
    const protocol = isLocal ? "http" : "https";
    return `${protocol}://${host}/callback`;
  }
  return DEFAULT_REDIRECT_URI;
}

export interface OAuthConfig {
  clientId: string;
  clientSecret?: string;
  authorizeUrl: string;
  tokenUrl: string;
  redirectUri: string;
  scopes: string[];
  /** Enable PKCE (Proof Key for Code Exchange) — required for public clients */
  usePkce?: boolean;
  /** Auth0 audience parameter */
  audience?: string;
  /** How to send client credentials to the token endpoint.
   *  "body" (default): client_id/client_secret as form params
   *  "basic": HTTP Basic Auth header (base64-encoded client_id:client_secret) */
  tokenAuthMethod?: "body" | "basic";
  /** Separator for scopes in the authorization URL. Default is " " (space, per OAuth 2.0 spec).
   *  Some providers (e.g. Strava) require "," instead. */
  scopeSeparator?: string;
}

// ============================================================
// PKCE helpers
// ============================================================

export function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

export function generateCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date;
  scopes: string | null;
}

type FetchFn = typeof globalThis.fetch;

export function buildAuthorizationUrl(
  config: OAuthConfig,
  pkce?: { codeChallenge: string },
): string {
  const url = new URL(config.authorizeUrl);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", config.scopes.join(config.scopeSeparator ?? " "));
  if (config.audience) {
    url.searchParams.set("audience", config.audience);
  }
  if (pkce) {
    url.searchParams.set("code_challenge", pkce.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
  }
  return url.toString();
}

/** Default expiry when the provider omits `expires_in` — 1 year.
 *  Providers that don't return `expires_in` typically issue non-expiring tokens
 *  (e.g. Doorkeeper with `access_token_expires_in nil`). Using a conservative
 *  1-year fallback avoids premature refresh attempts while still eventually
 *  re-validating. */
const DEFAULT_EXPIRES_IN_SECONDS = 365 * 24 * 60 * 60;

function parseTokenResponse(data: Record<string, unknown>): TokenSet {
  const expiresIn =
    typeof data.expires_in === "number" ? data.expires_in : DEFAULT_EXPIRES_IN_SECONDS;
  return {
    accessToken: String(data.access_token),
    refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : null,
    expiresAt: new Date(Date.now() + expiresIn * 1000),
    scopes: typeof data.scope === "string" ? data.scope : null,
  };
}

export async function exchangeCodeForTokens(
  config: OAuthConfig,
  code: string,
  fetchFn: FetchFn = globalThis.fetch,
  pkce?: { codeVerifier: string },
): Promise<TokenSet> {
  const useBasicAuth = config.tokenAuthMethod === "basic";
  const params: Record<string, string> = {
    grant_type: "authorization_code",
    code,
    redirect_uri: config.redirectUri,
  };
  if (!useBasicAuth) {
    params.client_id = config.clientId;
    if (config.clientSecret) params.client_secret = config.clientSecret;
  }
  if (pkce) params.code_verifier = pkce.codeVerifier;

  const body = new URLSearchParams(params);
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (useBasicAuth && config.clientSecret) {
    headers.Authorization = `Basic ${btoa(`${config.clientId}:${config.clientSecret}`)}`;
  }

  const response = await fetchFn(config.tokenUrl, {
    method: "POST",
    headers,
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token exchange failed (${response.status}): ${text}`);
  }

  const data = await response.json();
  const parsed: Record<string, unknown> = data;
  return parseTokenResponse(parsed);
}

export async function refreshAccessToken(
  config: OAuthConfig,
  refreshToken: string,
  fetchFn: FetchFn = globalThis.fetch,
): Promise<TokenSet> {
  const useBasicAuth = config.tokenAuthMethod === "basic";
  const params: Record<string, string> = {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  };
  if (!useBasicAuth) {
    params.client_id = config.clientId;
    if (config.clientSecret) params.client_secret = config.clientSecret;
  }

  const body = new URLSearchParams(params);
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (useBasicAuth && config.clientSecret) {
    headers.Authorization = `Basic ${btoa(`${config.clientId}:${config.clientSecret}`)}`;
  }

  const response = await fetchFn(config.tokenUrl, {
    method: "POST",
    headers,
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token refresh failed (${response.status}): ${text}`);
  }

  const data = await response.json();
  const parsed: Record<string, unknown> = data;
  return parseTokenResponse(parsed);
}
