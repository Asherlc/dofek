import { z } from "zod";
import {
  exchangeCodeForTokens,
  getOAuthRedirectUri,
  type OAuthConfig,
  type TokenSet,
} from "../../auth/oauth.ts";
import { ProviderAuthorizationFailedError } from "../auth-errors.ts";
import type { ProviderAuthSetup } from "../types.ts";

const ZIVA_ISSUER = "https://connect.ziva.fit/";
const ZIVA_RESOURCE = "https://connect.ziva.fit/mcp";

const zivaAccessTokenClaimsSchema = z.object({
  iss: z.literal(ZIVA_ISSUER),
  aud: z.union([
    z.literal(ZIVA_RESOURCE),
    z.array(z.string()).refine((audience) => audience.includes(ZIVA_RESOURCE)),
  ]),
  sub: z.string().trim().min(1),
});

function zivaOAuthConfig(host?: string): OAuthConfig | undefined {
  const clientId = process.env.ZIVA_CLIENT_ID;
  const clientSecret = process.env.ZIVA_CLIENT_SECRET;
  if (!clientId || !clientSecret) return undefined;

  return {
    clientId,
    clientSecret,
    authorizeUrl: "https://connect.ziva.fit/authorize",
    tokenUrl: "https://connect.ziva.fit/token",
    redirectUri: getOAuthRedirectUri(host),
    scopes: [],
    usePkce: true,
    tokenAuthMethod: "body",
    resource: ZIVA_RESOURCE,
  };
}

function decodeJwtClaims(accessToken: string): unknown {
  const segments = accessToken.split(".");
  if (segments.length !== 3 || !segments[1]) {
    throw new Error("Ziva access token is not a JWT");
  }

  return JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8"));
}

export function validateZivaAuthConfiguration(): string | null {
  if (!process.env.ZIVA_CLIENT_ID) return "ZIVA_CLIENT_ID is not set";
  if (!process.env.ZIVA_CLIENT_SECRET) return "ZIVA_CLIENT_SECRET is not set";
  return null;
}

export function zivaSubjectFromAccessToken(accessToken: string): string {
  try {
    return zivaAccessTokenClaimsSchema.parse(decodeJwtClaims(accessToken)).sub;
  } catch (error: unknown) {
    throw new ProviderAuthorizationFailedError("Ziva", {
      cause: error instanceof Error ? error : undefined,
    });
  }
}

export function validateZivaRefreshedIdentity(
  currentTokens: TokenSet,
  refreshedTokens: TokenSet,
): void {
  const storedSubject = z.string().trim().min(1).safeParse(currentTokens.providerAccountId);
  const refreshedSubject = zivaSubjectFromAccessToken(refreshedTokens.accessToken);
  if (!storedSubject.success || refreshedSubject !== storedSubject.data) {
    throw new ProviderAuthorizationFailedError("Ziva");
  }
}

export function createZivaAuthSetup(
  options?: { host?: string },
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): ProviderAuthSetup | undefined {
  const config = zivaOAuthConfig(options?.host);
  if (!config) return undefined;

  return {
    oauthConfig: config,
    exchangeCode: async (code, codeVerifier) => {
      if (!codeVerifier?.trim()) {
        throw new Error("Ziva OAuth code exchange requires a PKCE verifier");
      }
      const tokens = await exchangeCodeForTokens(config, code, fetchFn, { codeVerifier });
      return {
        ...tokens,
        providerAccountId: zivaSubjectFromAccessToken(tokens.accessToken),
      };
    },
  };
}
