import {
  ProviderRateLimitError,
  ProviderRequestTimeoutError,
  ProviderServiceUnavailableError,
} from "@dofek/provider-http/rate-limit";
import { z } from "zod";
import { exchangeCodeForTokens, getOAuthRedirectUri, type OAuthConfig } from "../../auth/oauth.ts";
import { redactProviderServiceUnavailableError } from "../../lib/provider-transport-error.ts";
import { ProviderAuthorizationFailedError } from "../auth-errors.ts";
import type { ProviderAuthSetup } from "../types.ts";

/** Trailforks MCP protected resource (RFC 8707) for activities:read. */
export const TRAILFORKS_MCP_RESOURCE = "https://www.trailforks.com/mcp/account/";

const TOKEN_EXCHANGE_FAILED = "Trailforks token exchange failed.";
const TRANSPORT_UNAVAILABLE = "Trailforks is temporarily unavailable. Try again.";

/** RFC 6749 §5.2 token-endpoint codes that establish an authorization rejection. */
const authorizationRejectionSchema = z.object({
  error: z.enum(["invalid_grant", "invalid_client", "unauthorized_client"]),
});

/** Statusless token-endpoint transport failure — a fetch rejection has no HTTP status. */
class TrailforksTokenTransportError extends Error {
  constructor() {
    super(TRANSPORT_UNAVAILABLE);
    this.name = "TrailforksTokenTransportError";
  }
}

/**
 * Public-client OAuth configuration for Trailforks MCP.
 * Requires TRAILFORKS_CLIENT_ID; no client secret (token_endpoint_auth_methods_supported: none).
 */
export function trailforksOAuthConfig(options?: { host?: string }): OAuthConfig | undefined {
  const clientId = process.env.TRAILFORKS_CLIENT_ID;
  if (!clientId) return undefined;

  return {
    clientId,
    authorizeUrl: "https://www.trailforks.com/mcp/oauth/authorize/",
    tokenUrl: "https://www.trailforks.com/mcp/oauth/token/",
    revokeUrl: "https://www.trailforks.com/mcp/oauth/revoke/",
    redirectUri: getOAuthRedirectUri(options?.host),
    scopes: ["activities:read"],
    usePkce: true,
    resource: TRAILFORKS_MCP_RESOURCE,
  };
}

export function validateTrailforksAuthConfiguration(): string | null {
  if (!process.env.TRAILFORKS_CLIENT_ID) return "TRAILFORKS_CLIENT_ID is not set";
  return null;
}

function discardResponseBody(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}

function sanitizedRateLimitError(error: ProviderRateLimitError): ProviderRateLimitError {
  return new ProviderRateLimitError({
    ...error,
    message: "Trailforks rate limit exceeded.",
    responseBody: "",
  });
}

function sanitizedTimeoutError(error: ProviderRequestTimeoutError): ProviderRequestTimeoutError {
  return new ProviderRequestTimeoutError({ ...error, cause: undefined });
}

function serviceUnavailable(statusCode: number): ProviderServiceUnavailableError {
  return new ProviderServiceUnavailableError({
    providerId: "trailforks",
    statusCode,
    message: `Trailforks is temporarily unavailable (${statusCode}). Try again.`,
    responseBody: "",
  });
}

function rethrowSanitizedTransport(error: unknown): never {
  if (error instanceof ProviderRateLimitError) throw sanitizedRateLimitError(error);
  if (error instanceof ProviderRequestTimeoutError) throw sanitizedTimeoutError(error);
  if (error instanceof ProviderServiceUnavailableError) {
    throw redactProviderServiceUnavailableError(error, "Trailforks is temporarily unavailable");
  }
  throw new TrailforksTokenTransportError();
}

async function isAuthorizationRejection(response: Response): Promise<boolean> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    discardResponseBody(response);
    return false;
  }
  try {
    const body: unknown = await response.json();
    return authorizationRejectionSchema.safeParse(body).success;
  } catch {
    return false;
  }
}

/**
 * Inspect non-OK token responses before the shared helper reads the raw body.
 * Confirmed RFC 6749 authorization rejections become credential failures; other
 * non-OK outcomes stay transport or generic exchange failures without remote text.
 */
function createTrailforksTokenExchangeFetch(
  fetchFn: typeof globalThis.fetch,
): typeof globalThis.fetch {
  return async (input, init) => {
    let response: Response;
    try {
      response = await fetchFn(input, init);
    } catch (error: unknown) {
      rethrowSanitizedTransport(error);
    }

    if (response.ok) return response;

    if (response.status >= 500 && response.status <= 599) {
      discardResponseBody(response);
      throw serviceUnavailable(response.status);
    }

    if (response.status === 400 || response.status === 401) {
      if (await isAuthorizationRejection(response)) {
        throw new ProviderAuthorizationFailedError("Trailforks");
      }
      throw new Error(TOKEN_EXCHANGE_FAILED);
    }

    discardResponseBody(response);
    throw new Error(TOKEN_EXCHANGE_FAILED);
  };
}

export function createTrailforksAuthSetup(
  options?: { host?: string },
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): ProviderAuthSetup | undefined {
  const config = trailforksOAuthConfig(options);
  if (!config) return undefined;

  const tokenFetch = createTrailforksTokenExchangeFetch(fetchFn);

  return {
    oauthConfig: config,
    exchangeCode: async (code, codeVerifier) => {
      if (!codeVerifier?.trim()) {
        throw new Error("Trailforks OAuth code exchange requires a PKCE verifier");
      }
      try {
        return await exchangeCodeForTokens(config, code, tokenFetch, { codeVerifier });
      } catch (error: unknown) {
        // Token fetch already emits sanitized local errors; never rethrow remote-laden unknowns.
        if (
          error instanceof ProviderAuthorizationFailedError ||
          error instanceof ProviderRateLimitError ||
          error instanceof ProviderRequestTimeoutError ||
          error instanceof ProviderServiceUnavailableError ||
          error instanceof TrailforksTokenTransportError
        ) {
          throw error;
        }
        throw new Error(TOKEN_EXCHANGE_FAILED);
      }
    },
    apiBaseUrl: TRAILFORKS_MCP_RESOURCE,
  };
}
