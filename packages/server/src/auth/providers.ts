import type { OAuth2Tokens } from "arctic";
import { Apple, decodeIdToken, Google, generateCodeVerifier, generateState } from "arctic";
import { createAppleClientSecret, decodePemToDer } from "dofek/auth/apple-client-secret";
import { getApplePrivateKey, hasApplePrivateKey } from "dofek/auth/apple-private-key";
import { z } from "zod";

const googleClaimsSchema = z.object({
  sub: z.string(),
  email: z.string().optional(),
  email_verified: z.boolean(),
  name: z.string().optional(),
});

const appleClaimsSchema = z.object({
  sub: z.string(),
  email: z.string().optional(),
  email_verified: z.union([z.boolean(), z.enum(["true", "false"])]),
});

import { IDENTITY_PROVIDER_NAMES, type IdentityProviderName } from "@dofek/auth/auth";
export type { IdentityProviderName };

// ── Provider types ──

export interface IdentityUser {
  sub: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  groups: string[] | null;
}

export interface AppleRevocationCredential {
  accessToken: string;
  clientId: string;
  refreshToken: string | null;
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
          emailVerified: claims.email_verified,
          name: claims.name ?? null,
          groups: null,
        },
      };
    },
  };
}

function initApple(): IdentityProvider {
  const privateKeyPem = getApplePrivateKey();
  const derBytes = decodePemToDer(privateKeyPem);
  if (derBytes.length === 0) {
    throw new Error(
      "APPLE_PRIVATE_KEY decoded to 0 bytes — check the PEM format in your secret manager",
    );
  }
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
        user: {
          sub: claims.sub,
          email: claims.email ?? null,
          emailVerified: claims.email_verified === true || claims.email_verified === "true",
          name: null,
          groups: null,
        },
      };
    },
  };
}

const initializers: Record<IdentityProviderName, () => IdentityProvider> = {
  google: initGoogle,
  apple: initApple,
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
};

/** Check if all required env vars for a provider are set. */
export function isProviderConfigured(name: IdentityProviderName): boolean {
  return requiredEnvKeys[name].every((key) =>
    key === "APPLE_PRIVATE_KEY" ? hasApplePrivateKey() : !!process.env[key],
  );
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
  return nativeAppleRequiredEnvKeys.every((key) =>
    key === "APPLE_PRIVATE_KEY" ? hasApplePrivateKey() : !!process.env[key],
  );
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
  access_token: z.string(),
  id_token: z.string(),
  refresh_token: z.string().optional(),
});

/**
 * Exchange a native iOS Apple Sign In authorization code for user info.
 *
 * Native codes are issued by ASAuthorizationController using the app's Bundle ID,
 * not the web Services ID. The token exchange must use the Bundle ID as client_id
 * and must NOT include a redirect_uri (there is none in the native flow).
 */
export async function validateNativeAppleCallback(
  authorizationCode: string,
): Promise<{ revocationCredential: AppleRevocationCredential; user: IdentityUser }> {
  const bundleId = getEnvRequired("APPLE_BUNDLE_ID");
  const teamId = getEnvRequired("APPLE_TEAM_ID");
  const keyId = getEnvRequired("APPLE_KEY_ID");
  const privateKeyPem = getApplePrivateKey();
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
  const parsedTokens = appleTokenResponseSchema.parse(data);
  const idToken = parsedTokens.id_token;
  const claims = appleClaimsSchema.parse(decodeIdToken(idToken));

  return {
    revocationCredential: {
      accessToken: parsedTokens.access_token,
      clientId: bundleId,
      refreshToken: parsedTokens.refresh_token ?? null,
    },
    user: {
      sub: claims.sub,
      email: claims.email ?? null,
      emailVerified: claims.email_verified === true || claims.email_verified === "true",
      name: null,
      groups: null,
    },
  };
}

export function appleRevocationCredentialFromTokens(
  tokens: OAuth2Tokens,
  clientId: string,
): AppleRevocationCredential {
  return {
    accessToken: tokens.accessToken(),
    clientId,
    refreshToken: tokens.hasRefreshToken() ? tokens.refreshToken() : null,
  };
}

export { decodePemToDer };
export { generateCodeVerifier, generateState };
