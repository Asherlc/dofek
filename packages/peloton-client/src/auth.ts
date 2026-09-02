import { createHash, randomBytes } from "node:crypto";
import { createRateLimitAwareFetch } from "@dofek/provider-http/rate-limit";
import { z } from "zod";
import { PelotonAuthFlowError, PelotonResponseError } from "./errors.ts";
import type { PelotonOAuthConfig, PelotonTokenSet } from "./types.ts";

const PELOTON_AUTH_DOMAIN = "https://auth.onepeloton.com";
const PELOTON_CLIENT_ID = "WVoJxVDdPoFx4RNewvvg6ch2mZ7bwnsM";
const PELOTON_REDIRECT_URI = "https://members.onepeloton.com/callback";
const PELOTON_API_BASE = "https://api.onepeloton.com";
const AUTH0_CLIENT = btoa(JSON.stringify({ name: "auth0.js-ulp", version: "9.14.3" }));
const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().positive(),
  scope: z.string().optional(),
});
const injectedConfigSchema = z.object({
  extraParams: z.object({
    state: z.string().min(1),
    _csrf: z.string().min(1),
    nonce: z.string().optional(),
  }),
});

export function pelotonOAuthConfig(_host?: string): PelotonOAuthConfig {
  return {
    clientId: PELOTON_CLIENT_ID,
    authorizeUrl: `${PELOTON_AUTH_DOMAIN}/authorize`,
    tokenUrl: `${PELOTON_AUTH_DOMAIN}/oauth/token`,
    redirectUri: PELOTON_REDIRECT_URI,
    scopes: ["offline_access", "openid", "peloton-api.members:default"],
    usePkce: true,
    audience: `${PELOTON_API_BASE}/`,
  };
}

function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

function generateCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function buildAuthorizationUrl(codeChallenge: string, state?: string, nonce?: string): string {
  const config = pelotonOAuthConfig();
  const url = new URL(config.authorizeUrl);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", config.scopes.join(" "));
  url.searchParams.set("audience", config.audience);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (state) url.searchParams.set("state", state);
  if (nonce) url.searchParams.set("nonce", nonce);
  return url.toString();
}

export interface PelotonAuthorization {
  url: string;
  codeVerifier: string;
}

export function createPelotonAuthorization(): PelotonAuthorization {
  const codeVerifier = generateCodeVerifier();
  return {
    url: buildAuthorizationUrl(generateCodeChallenge(codeVerifier)),
    codeVerifier,
  };
}

async function requestTokens(
  params: Record<string, string>,
  fallbackRefreshToken: string | null,
  fetchFn: typeof globalThis.fetch,
): Promise<PelotonTokenSet> {
  const config = pelotonOAuthConfig();
  const rateLimitFetch = createRateLimitAwareFetch(fetchFn, { providerId: "peloton" });
  const response = await rateLimitFetch(config.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...params, client_id: config.clientId }).toString(),
  });
  if (!response.ok) {
    const responseBody = await response.text();
    throw new PelotonAuthFlowError("token", `Peloton token request failed (${response.status})`, {
      statusCode: response.status,
      responseBody,
    });
  }

  try {
    const body = tokenResponseSchema.parse(await response.json());
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token ?? fallbackRefreshToken,
      expiresAt: new Date(Date.now() + body.expires_in * 1000),
      scopes: body.scope ?? null,
    };
  } catch (error: unknown) {
    throw new PelotonResponseError("token", error);
  }
}

export function exchangePelotonAuthorizationCode(
  code: string,
  codeVerifier: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<PelotonTokenSet> {
  const config = pelotonOAuthConfig();
  return requestTokens(
    {
      grant_type: "authorization_code",
      code,
      redirect_uri: config.redirectUri,
      code_verifier: codeVerifier,
    },
    null,
    fetchFn,
  );
}

export function refreshPelotonAccessToken(
  refreshToken: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<PelotonTokenSet> {
  return requestTokens(
    { grant_type: "refresh_token", refresh_token: refreshToken },
    refreshToken,
    fetchFn,
  );
}

export function parseAuth0FormHtml(html: string): {
  action: string;
  fields: Record<string, string>;
} {
  const rawAction = html.match(/<form[^>]+action="([^"]+)"/)?.[1];
  if (!rawAction) {
    throw new PelotonAuthFlowError("login-form", "Could not find form action in Auth0 response");
  }
  const action = decodeHtmlEntities(rawAction);

  const fields: Record<string, string> = {};
  for (const match of html.matchAll(/<input[^>]+type="hidden"[^>]*>/gi)) {
    const tag = match[0];
    const name = tag.match(/name="([^"]+)"/)?.[1];
    if (name) fields[name] = tag.match(/value="([^"]*)"/)?.[1] ?? "";
  }
  return { action, fields };
}

function getSetCookieHeaders(headers: Headers): string[] {
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
  const combined = headers.get("set-cookie");
  return combined ? combined.split(/,\s*(?=[^;,=\s]+=[^;,]*)/) : [];
}

class CookieJar {
  #cookies = new Map<string, Map<string, string>>();

  addFromResponse(url: string, headers: Headers): void {
    const domain = new URL(url).hostname;
    const cookies = this.#cookies.get(domain) ?? new Map<string, string>();
    for (const header of getSetCookieHeaders(headers)) {
      const match = header.match(/^([^=]+)=([^;]*)/);
      const name = match?.[1];
      const value = match?.[2];
      if (name !== undefined && value !== undefined) cookies.set(name, value);
    }
    this.#cookies.set(domain, cookies);
  }

  getForUrl(url: string): string {
    const hostname = new URL(url).hostname;
    const values: string[] = [];
    for (const [domain, cookies] of this.#cookies) {
      if (hostname === domain || hostname.endsWith(`.${domain}`)) {
        for (const [name, value] of cookies) values.push(`${name}=${value}`);
      }
    }
    return values.join("; ");
  }
}

async function followRedirect(
  url: string,
  jar: CookieJar,
  fetchFn: typeof globalThis.fetch,
  init?: RequestInit,
): Promise<{ response: Response; location: string | null }> {
  const fullUrl = new URL(url, PELOTON_AUTH_DOMAIN).toString();
  const response = await fetchFn(fullUrl, {
    ...init,
    redirect: "manual",
    headers: { ...(init?.headers ?? {}), Cookie: jar.getForUrl(fullUrl) },
  });
  jar.addFromResponse(fullUrl, response.headers);
  return { response, location: response.headers.get("location") };
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#34;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export async function pelotonAutomatedLogin(
  email: string,
  password: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<PelotonTokenSet> {
  const rateLimitFetch = createRateLimitAwareFetch(fetchFn, { providerId: "peloton" });
  const config = pelotonOAuthConfig();
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = generateCodeVerifier();
  const nonce = generateCodeVerifier();
  const jar = new CookieJar();

  let { response, location } = await followRedirect(
    buildAuthorizationUrl(codeChallenge, state, nonce),
    jar,
    rateLimitFetch,
  );
  let redirectsRemaining = 15;
  while (location && redirectsRemaining > 0) {
    ({ response, location } = await followRedirect(location, jar, rateLimitFetch));
    redirectsRemaining--;
  }
  if (location) {
    throw new PelotonAuthFlowError("authorize", "Auth0 authorization redirect limit exceeded");
  }

  const loginPageHtml = await response.text();
  const encodedConfig = loginPageHtml.match(/window\.injectedConfig\s*=\s*[^"]*"([^"]+)"/)?.[1];
  if (!encodedConfig) {
    throw new PelotonAuthFlowError(
      "authorize",
      "Could not find injectedConfig in Auth0 login page",
    );
  }

  let extraParams: z.infer<typeof injectedConfigSchema>["extraParams"];
  try {
    extraParams = injectedConfigSchema.parse(
      JSON.parse(Buffer.from(encodedConfig, "base64").toString("utf8")),
    ).extraParams;
  } catch (error: unknown) {
    throw new PelotonResponseError("Auth0 injected configuration", error);
  }

  const loginUrl = `${PELOTON_AUTH_DOMAIN}/usernamepassword/login`;
  const { response: loginResponse } = await followRedirect(loginUrl, jar, rateLimitFetch, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Auth0-Client": AUTH0_CLIENT },
    body: JSON.stringify({
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      tenant: "peloton-prod",
      response_type: "code",
      scope: config.scopes.join(" "),
      audience: config.audience,
      _csrf: extraParams._csrf,
      state: extraParams.state,
      nonce: extraParams.nonce ?? nonce,
      connection: "pelo-user-password",
      username: email,
      password,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    }),
  });
  if (!loginResponse.ok) {
    const responseBody = await loginResponse.text();
    throw new PelotonAuthFlowError(
      "credentials",
      `Auth0 login failed (${loginResponse.status}): ${responseBody}`,
      { statusCode: loginResponse.status, responseBody },
    );
  }

  const { action, fields: encodedFields } = parseAuth0FormHtml(await loginResponse.text());
  const fields = Object.fromEntries(
    Object.entries(encodedFields).map(([key, value]) => [key, decodeHtmlEntities(value)]),
  );
  let { location: callbackLocation } = await followRedirect(action, jar, rateLimitFetch, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });

  redirectsRemaining = 15;
  while (
    callbackLocation &&
    !callbackLocation.includes("code=") &&
    !callbackLocation.includes("error=") &&
    redirectsRemaining > 0
  ) {
    ({ location: callbackLocation } = await followRedirect(callbackLocation, jar, rateLimitFetch));
    redirectsRemaining--;
  }
  if (!callbackLocation) {
    throw new PelotonAuthFlowError(
      "callback",
      "Auth0 redirect chain ended without a Location header",
    );
  }

  const callbackUrl = new URL(callbackLocation, PELOTON_REDIRECT_URI);
  const authError = callbackUrl.searchParams.get("error");
  if (authError) {
    throw new PelotonAuthFlowError(
      "callback",
      `Auth0 returned error: ${callbackUrl.searchParams.get("error_description") ?? authError}`,
    );
  }
  const code = callbackUrl.searchParams.get("code");
  if (!code) {
    throw new PelotonAuthFlowError("callback", "Authorization code not found in callback URL");
  }
  return exchangePelotonAuthorizationCode(code, codeVerifier, rateLimitFetch);
}
