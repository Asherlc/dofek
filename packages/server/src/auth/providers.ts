import type { OAuth2Tokens } from "arctic";
import {
  Apple,
  Authentik,
  decodeIdToken,
  Google,
  generateCodeVerifier,
  generateState,
} from "arctic";

// ── Provider types ──

export type IdentityProviderName = "google" | "apple" | "authentik";

export interface IdentityUser {
  sub: string;
  email: string | null;
  name: string | null;
}

interface IdentityProvider {
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
      // @ts-expect-error decodeIdToken returns {} but we know it has sub/email/name for Google
      const claims: {
        sub: string;
        email?: string;
        name?: string;
      } = decodeIdToken(tokens.idToken());
      return {
        tokens,
        user: { sub: claims.sub, email: claims.email ?? null, name: claims.name ?? null },
      };
    },
  };
}

function initApple(): IdentityProvider {
  const privateKeyPem = getEnvRequired("APPLE_PRIVATE_KEY");
  const pkcs8Key = new TextEncoder().encode(privateKeyPem);
  const client = new Apple(
    getEnvRequired("APPLE_CLIENT_ID"),
    getEnvRequired("APPLE_TEAM_ID"),
    getEnvRequired("APPLE_KEY_ID"),
    pkcs8Key,
    getEnvRequired("APPLE_REDIRECT_URI"),
  );
  return {
    createAuthorizationUrl(state, _codeVerifier) {
      // Apple doesn't use PKCE
      return client.createAuthorizationURL(state, ["name", "email"]);
    },
    async validateCallback(code, _codeVerifier) {
      // Apple doesn't use PKCE
      const tokens = await client.validateAuthorizationCode(code);
      // @ts-expect-error decodeIdToken returns {} but we know it has sub/email for Apple
      const claims: {
        sub: string;
        email?: string;
      } = decodeIdToken(tokens.idToken());
      return {
        tokens,
        // Apple only sends name on first authorization, not in the ID token
        user: { sub: claims.sub, email: claims.email ?? null, name: null },
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
      return client.createAuthorizationURL(state, codeVerifier, ["openid", "email", "profile"]);
    },
    async validateCallback(code, codeVerifier) {
      const tokens = await client.validateAuthorizationCode(code, codeVerifier);
      // @ts-expect-error decodeIdToken returns {} but we know it has sub/email/name for Authentik
      const claims: {
        sub: string;
        email?: string;
        preferred_username?: string;
        name?: string;
      } = decodeIdToken(tokens.idToken());
      return {
        tokens,
        user: {
          sub: claims.sub,
          email: claims.email ?? null,
          name: claims.name ?? claims.preferred_username ?? null,
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
  // @ts-expect-error Object.keys returns string[] but we know the keys are IdentityProviderName
  const names: IdentityProviderName[] = Object.keys(requiredEnvKeys);
  return names.filter(isProviderConfigured);
}

export { generateCodeVerifier, generateState };
