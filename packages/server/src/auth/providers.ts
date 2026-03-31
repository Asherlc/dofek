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

/** Get a configured identity provider. Throws if env vars are missing. */
export function getIdentityProvider(name: IdentityProviderName): IdentityProvider {
  let provider = providers.get(name);
  if (!provider) {
    provider = initializers[name]();
    providers.set(name, provider);
  }
  return provider;
}

/** List all configured identity providers. */
export function getConfiguredProviders(): IdentityProviderName[] {
  return [...IDENTITY_PROVIDER_NAMES].filter(isProviderConfigured);
}

export { generateCodeVerifier, generateState };
