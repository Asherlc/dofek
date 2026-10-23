import { randomUUID } from "node:crypto";
import {
  ProviderRateLimitError,
  ProviderServiceUnavailableError,
} from "@dofek/provider-http/rate-limit";
import { z } from "zod";
import {
  exchangeCodeForTokens,
  getOAuthRedirectUri,
  type OAuthConfig,
  refreshAccessToken,
  type TokenSet,
} from "../../auth/oauth.ts";
import { ProviderConnectionError } from "../auth-errors.ts";
import type { ProviderAuthSetup, ProviderRevocationTokenPersistence } from "../types.ts";
import { assertGarminAuthorizationOwner } from "./authorization.ts";
import { reportGarminConnectionHttpFailure } from "./oauth-diagnostics.ts";

export const GARMIN_API_BASE = "https://apis.garmin.com/partner-gateway/rest";

const userIdSchema = z.object({ userId: z.string().trim().min(1) });
const permissionsSchema = z.object({ permissions: z.array(z.string().min(1)) });

export function createGarminAuthSetup(
  fetchFn: typeof globalThis.fetch,
  host?: string,
): ProviderAuthSetup {
  const clientId = process.env.GARMIN_CLIENT_ID;
  const clientSecret = process.env.GARMIN_CLIENT_SECRET;
  if (!clientId?.trim() || !clientSecret?.trim()) {
    throw new Error("GARMIN_CLIENT_ID and GARMIN_CLIENT_SECRET are required");
  }

  const config: OAuthConfig = {
    clientId,
    clientSecret,
    authorizeUrl: "https://connect.garmin.com/oauth2Confirm",
    tokenUrl: "https://diauth.garmin.com/di-oauth2-service/oauth/token",
    redirectUri: getOAuthRedirectUri(host),
    scopes: [],
    usePkce: true,
    tokenAuthMethod: "basic",
  };

  async function readUserResource(
    path: "id" | "permissions",
    accessToken: string,
  ): Promise<unknown> {
    let response: Response | null = null;
    let statusCode: number;
    try {
      response = await fetchFn(`${GARMIN_API_BASE}/user/${path}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      statusCode = response.status;
    } catch (error) {
      if (
        !(error instanceof ProviderRateLimitError) &&
        !(error instanceof ProviderServiceUnavailableError)
      ) {
        throw error;
      }
      statusCode = error.statusCode;
    }
    if (response?.ok) return response.json();
    const error = new ProviderConnectionError(
      "Garmin Connect",
      path === "id" ? "identity" : "permissions",
      statusCode,
    );
    await reportGarminConnectionHttpFailure(response, error);
    throw error;
  }

  async function revokeAuthorization(
    tokens: TokenSet,
    onTokensRefreshed?: ProviderRevocationTokenPersistence,
  ): Promise<void> {
    if (!tokens.providerAccountId?.trim() && !tokens.authorizationId) {
      throw new Error("Garmin authorization has no official account ID; reconnect Garmin first");
    }
    let accessToken = tokens.accessToken;
    if (tokens.expiresAt.getTime() <= Date.now()) {
      if (!tokens.refreshToken) {
        throw new Error(
          "Garmin authorization expired without a refresh token; reconnect Garmin first",
        );
      }
      if (!onTokensRefreshed) {
        throw new Error("Garmin revocation requires durable credential persistence before refresh");
      }
      const refreshed = await refreshAccessToken(config, tokens.refreshToken, fetchFn);
      const updatedTokens = { ...tokens, ...refreshed, scopes: tokens.scopes };
      await onTokensRefreshed(updatedTokens);
      accessToken = updatedTokens.accessToken;
    }
    const response = await fetchFn(`${GARMIN_API_BASE}/user/registration`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
      throw new Error(`Garmin registration deletion failed (${response.status})`);
    }
  }

  return {
    assertCanConnect: assertGarminAuthorizationOwner,
    oauthConfig: config,
    apiBaseUrl: GARMIN_API_BASE,
    reconnectStrategy: "replace",
    exchangeCode: async (code, codeVerifier, onTokensIssued) => {
      if (!codeVerifier?.trim()) {
        throw new Error("Garmin OAuth requires the original PKCE code verifier");
      }
      const tokens = {
        ...(await exchangeCodeForTokens(config, code, fetchFn, { codeVerifier })),
        authorizationId: randomUUID(),
      };
      onTokensIssued?.(tokens);
      const { userId } = userIdSchema.parse(await readUserResource("id", tokens.accessToken));
      const identifiedTokens = { ...tokens, providerAccountId: userId };
      onTokensIssued?.(identifiedTokens);
      const { permissions } = permissionsSchema.parse(
        await readUserResource("permissions", tokens.accessToken),
      );
      return { ...identifiedTokens, scopes: permissions.join(" ") };
    },
    revokeExistingTokens: revokeAuthorization,
    revokeTokensForAccountErasure: revokeAuthorization,
  };
}
