import type { OAuth2Tokens } from "arctic";
import {
  Apple,
  Authentik,
  decodeIdToken,
  Google,
  generateCodeVerifier,
  generateState,
} from "arctic";
import { z } from "zod";

const googleClaimsSchema = z.object({
  sub: z.string(),
  email: z.string().optional(),
  name: z.string().optional(),
});

const appleClaimsSchema = z.object({
  sub: z.string(),
  email: z.string().optional(),
});

const authentikClaimsSchema = z.object({
  sub: z.string(),
  email: z.string().optional(),
  preferred_username: z.string().optional(),
  name: z.string().optional(),
  groups: z.array(z.string()).optional(),
});

import { IDENTITY_PROVIDER_NAMES, type IdentityProviderName } from "@dofek/auth/auth";
export type { IdentityProviderName };

// ── Provider types ──

export interface IdentityUser {
  sub: string;
  email: string | null;
  name: string | null;
  groups: string[] | null;
}

export interface IdentityProvider {
  createAuthorizationUrl(state: string, codeVerifier: string): URL;
  validateCallback(
    code: string,
    codeVerifier: string,
  ): Promise<{ tokens: OAuth2Tokens; user: IdentityUser }>;
}

// ── Provider instances (lazily created from env vars) ──

const providers = new Map<IdentityProviderName, IdentityProvider>();

function getEnvRequired(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required env var: ${key}`);
  return value;
}

function initGoogle(): IdentityProvider {
  const client = new Google(
    getEnvRequired("GOOGLE_CLIENT_ID"),
    getEnvRequired("GOOGLE_CLIENT_SECRET"),
    getEnvRequired("GOOGLE_REDIRECT_URI"),
  );
  return {
    createAuthorizationUrl(state, codeVerifier) {
      return client.createAuthorizationURL(state, codeVerifier, ["openid", "email", "profile"]);
    },
    async validateCallback(code, codeVerifier) {
      const tokens = await client.validateAuthorizationCode(code, codeVerifier);
      const claims = googleClaimsSchema.parse(decodeIdToken(tokens.idToken()));
      return {
        tokens,
        user: {
          sub: claims.sub,
          email: claims.email ?? null,
          name: claims.name ?? null,
          groups: null,
        },
      };
    },
  };
}

/** Strip PEM headers/footers and base64-decode to raw PKCS#8 DER bytes. */
export function decodePemToDer(pem: string): Uint8Array {
  const base64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s/g, "");
  return new Uint8Array(Buffer.from(base64, "base64"));
}

function initApple(): IdentityProvider {
  const privateKeyPem = getEnvRequired("APPLE_PRIVATE_KEY");
  const derBytes = decodePemToDer(privateKeyPem);
  const client = new Apple(
    getEnvRequired("APPLE_CLIENT_ID"),
    getEnvRequired("APPLE_TEAM_ID"),
    getEnvRequired("APPLE_KEY_ID"),
    derBytes,
    getEnvRequired("APPLE_REDIRECT_URI"),
  );
  return {
    createAuthorizationUrl(state, _codeVerifier) {
      // Apple doesn't use PKCE
      const url = client.createAuthorizationURL(state, ["name", "email"]);
      // Apple requires response_mode=form_post when requesting name or email scopes.
      // This means Apple POSTs the code/state to the callback URL instead of
      // redirecting via GET. The callback handler must accept POST requests.
      url.searchParams.set("response_mode", "form_post");
      return url;
    },
    async validateCallback(code, _codeVerifier) {
      // Apple doesn't use PKCE
      const tokens = await client.validateAuthorizationCode(code);
      const claims = appleClaimsSchema.parse(decodeIdToken(tokens.idToken()));
      return {
        tokens,
        // Apple only sends name on first authorization, not in the ID token
        user: { sub: claims.sub, email: claims.email ?? null, name: null, groups: null },
      };
    },
  };
}

function initAuthentik(): IdentityProvider {
  const client = new Authentik(
    getEnvRequired("AUTHENTIK_BASE_URL"),
    getEnvRequired("AUTHENTIK_CLIENT_ID"),
    getEnvRequired("AUTHENTIK_CLIENT_SECRET"),
    getEnvRequired("AUTHENTIK_REDIRECT_URI"),
  );
  return {
    createAuthorizationUrl(state, codeVerifier) {
      return client.createAuthorizationURL(state, codeVerifier, [
        "openid",
        "email",
        "profile",
        "groups",
      ]);
    },
    async validateCallback(code, codeVerifier) {
      const tokens = await client.validateAuthorizationCode(code, codeVerifier);
      const claims = authentikClaimsSchema.parse(decodeIdToken(tokens.idToken()));
      return {
        tokens,
        user: {
          sub: claims.sub,
          email: claims.email ?? null,
          name: claims.name ?? claims.preferred_username ?? null,
          groups: claims.groups ?? null,
        },
      };
    },
  };
}

const initializers: Record<IdentityProviderName, () => IdentityProvider> = {
  google: initGoogle,
  apple: initApple,
  authentik: initAuthentik,
};

/** Required env var prefixes per provider (used to check which are configured). */
const requiredEnvKeys: Record<IdentityProviderName, string[]> = {
  google: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI"],
  apple: [
    "APPLE_CLIENT_ID",
    "APPLE_TEAM_ID",
    "APPLE_KEY_ID",
    "APPLE_PRIVATE_KEY",
    "APPLE_REDIRECT_URI",
  ],
  authentik: [
    "AUTHENTIK_BASE_URL",
    "AUTHENTIK_CLIENT_ID",
    "AUTHENTIK_CLIENT_SECRET",
    "AUTHENTIK_REDIRECT_URI",
  ],
};

/** Check if all required env vars for a provider are set. */
export function isProviderConfigured(name: IdentityProviderName): boolean {
  return requiredEnvKeys[name].every((key) => !!process.env[key]);
}

/** Required env vars for native iOS Apple Sign In (uses Bundle ID, not Services ID). */
const nativeAppleRequiredEnvKeys = [
  "APPLE_BUNDLE_ID",
  "APPLE_TEAM_ID",
  "APPLE_KEY_ID",
  "APPLE_PRIVATE_KEY",
];

/** Check if native iOS Apple Sign In is configured. */
export function isNativeAppleConfigured(): boolean {
  return nativeAppleRequiredEnvKeys.every((key) => !!process.env[key]);
}

/** Get a configured identity provider. Throws if env vars are missing. */
export function getIdentityProvider(name: IdentityProviderName): IdentityProvider {
  let provider = providers.get(name);
  if (!provider) {
    if (!(name in initializers)) {
      throw new Error(`Unknown identity provider: ${name}`);
    }
    provider = initializers[name]();
    providers.set(name, provider);
  }
  return provider;
}

/** List all configured identity providers. */
export function getConfiguredProviders(): IdentityProviderName[] {
  return [...IDENTITY_PROVIDER_NAMES].filter(isProviderConfigured);
}

const appleTokenEndpoint = "https://appleid.apple.com/auth/token";

const appleTokenResponseSchema = z.object({
  id_token: z.string(),
});

/** Create the ES256 client_secret JWT that Apple requires for token exchange. */
async function createAppleClientSecret(
  teamId: string,
  keyId: string,
  pkcs8PrivateKey: Uint8Array,
  clientId: string,
): Promise<string> {
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8PrivateKey.slice().buffer,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: keyId, typ: "JWT" })).toString(
    "base64url",
  );
  const payload = Buffer.from(
    JSON.stringify({
      iss: teamId,
      iat: now,
      exp: now + 5 * 60,
      aud: "https://appleid.apple.com",
      sub: clientId,
    }),
  ).toString("base64url");
  const signingInput = new TextEncoder().encode(`${header}.${payload}`);
  const signature = Buffer.from(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, signingInput),
  ).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

/**
 * Exchange a native iOS Apple Sign In authorization code for user info.
 *
 * Native codes are issued by ASAuthorizationController using the app's Bundle ID,
 * not the web Services ID. The token exchange must use the Bundle ID as client_id
 * and must NOT include a redirect_uri (there is none in the native flow).
 */
export async function validateNativeAppleCallback(
  authorizationCode: string,
): Promise<{ user: IdentityUser }> {
  const bundleId = getEnvRequired("APPLE_BUNDLE_ID");
  const teamId = getEnvRequired("APPLE_TEAM_ID");
  const keyId = getEnvRequired("APPLE_KEY_ID");
  const privateKeyPem = getEnvRequired("APPLE_PRIVATE_KEY");
  const derBytes = decodePemToDer(privateKeyPem);

  const clientSecret = await createAppleClientSecret(teamId, keyId, derBytes, bundleId);

  const body = new URLSearchParams();
  body.set("grant_type", "authorization_code");
  body.set("code", authorizationCode);
  body.set("client_id", bundleId);
  body.set("client_secret", clientSecret);
  // No redirect_uri — native auth codes are not associated with one

  const response = await fetch(appleTokenEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Apple token exchange failed (${response.status}): ${text}`);
  }

  const data: unknown = await response.json();
  const { id_token: idToken } = appleTokenResponseSchema.parse(data);
  const claims = appleClaimsSchema.parse(decodeIdToken(idToken));

  return {
    user: { sub: claims.sub, email: claims.email ?? null, name: null, groups: null },
  };
}

export { generateCodeVerifier, generateState };
