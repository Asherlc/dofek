import { createHash, randomBytes } from "node:crypto";

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
  refreshToken: string;
  expiresAt: Date;
  scopes: string;
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
  url.searchParams.set("scope", config.scopes.join(" "));
  if (config.audience) {
    url.searchParams.set("audience", config.audience);
  }
  if (pkce) {
    url.searchParams.set("code_challenge", pkce.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
  }
  return url.toString();
}

function parseTokenResponse(data: Record<string, unknown>): TokenSet {
  const expiresIn = (data.expires_in as number) ?? 7200;
  return {
    accessToken: data.access_token as string,
    refreshToken: data.refresh_token as string,
    expiresAt: new Date(Date.now() + expiresIn * 1000),
    scopes: (data.scope as string) ?? "",
  };
}

export async function exchangeCodeForTokens(
  config: OAuthConfig,
  code: string,
  fetchFn: FetchFn = globalThis.fetch,
  pkce?: { codeVerifier: string },
): Promise<TokenSet> {
  const params: Record<string, string> = {
    grant_type: "authorization_code",
    code,
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
  };
  if (config.clientSecret) params.client_secret = config.clientSecret;
  if (pkce) params.code_verifier = pkce.codeVerifier;

  const body = new URLSearchParams(params);

  const response = await fetchFn(config.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token exchange failed (${response.status}): ${text}`);
  }

  const data = await response.json();
  return parseTokenResponse(data as Record<string, unknown>);
}

export async function refreshAccessToken(
  config: OAuthConfig,
  refreshToken: string,
  fetchFn: FetchFn = globalThis.fetch,
): Promise<TokenSet> {
  const params: Record<string, string> = {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: config.clientId,
  };
  if (config.clientSecret) params.client_secret = config.clientSecret;

  const body = new URLSearchParams(params);

  const response = await fetchFn(config.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token refresh failed (${response.status}): ${text}`);
  }

  const data = await response.json();
  return parseTokenResponse(data as Record<string, unknown>);
}
