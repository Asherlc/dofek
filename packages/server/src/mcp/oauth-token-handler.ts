import { createHash } from "node:crypto";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import {
  InvalidClientError,
  InvalidGrantError,
  InvalidRequestError,
  MethodNotAllowedError,
  OAuthError,
  ServerError,
  TooManyRequestsError,
  UnsupportedGrantTypeError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import express from "express";
import {
  rateLimit as createRateLimiter,
  type Options as RateLimitOptions,
} from "express-rate-limit";
import { z } from "zod";

const TokenRequestSchema = z.object({
  grant_type: z.string(),
});

const AuthorizationCodeGrantSchema = z.object({
  code: z.string(),
  code_verifier: z.string(),
  redirect_uri: z.string().optional(),
  resource: z.string().url().optional(),
});

const RefreshTokenGrantSchema = z.object({
  refresh_token: z.string(),
  scope: z.string().optional(),
  resource: z.string().url().optional(),
});

const ClientAuthenticatedRequestSchema = z.object({
  client_id: z.string(),
  client_secret: z.string().optional(),
});

function allowedMethods(allowed: string[]): express.RequestHandler {
  return (request, response, next) => {
    if (allowed.includes(request.method)) {
      next();
      return;
    }
    const error = new MethodNotAllowedError(
      `The method ${request.method} is not allowed for this endpoint`,
    );
    response.status(405).set("Allow", allowed.join(", ")).json(error.toResponseObject());
  };
}

/** CORS ``*`` and preflight handling, matching the default `cors()` behavior. */
const corsWildcard: express.RequestHandler = (request, response, next) => {
  response.setHeader("Access-Control-Allow-Origin", "*");
  if (request.method === "OPTIONS") {
    response.setHeader("Access-Control-Allow-Methods", "POST");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type");
    response.status(204).end();
    return;
  }
  next();
};

/**
 * Verifies a PKCE code_verifier against the supplied code_challenge using the
 * S256 method (SHA-256, base64url), matching `pkce-challenge`'s verifyChallenge.
 */
function verifyChallenge(codeVerifier: string, codeChallenge: string): boolean {
  const computed = createHash("sha256").update(codeVerifier).digest("base64url");
  return computed === codeChallenge;
}

async function authenticateClient(
  clientsStore: OAuthRegisteredClientsStore,
  body: unknown,
): Promise<OAuthClientInformationFull> {
  const result = ClientAuthenticatedRequestSchema.safeParse(body);
  if (!result.success) {
    throw new InvalidRequestError(result.error.message);
  }
  const { client_id: clientId, client_secret: clientSecret } = result.data;
  const client = await clientsStore.getClient(clientId);
  if (!client) {
    throw new InvalidClientError("Invalid client_id");
  }
  if (client.client_secret) {
    if (!clientSecret) {
      throw new InvalidClientError("Client secret is required");
    }
    if (client.client_secret !== clientSecret) {
      throw new InvalidClientError("Invalid client_secret");
    }
    if (
      client.client_secret_expires_at &&
      client.client_secret_expires_at < Math.floor(Date.now() / 1000)
    ) {
      throw new InvalidClientError("Client secret has expired");
    }
  }
  return client;
}

export interface TokenHandlerOptions {
  provider: OAuthServerProvider;
  rateLimit?: Partial<RateLimitOptions> | false;
}

export function tokenHandler({
  provider,
  rateLimit: rateLimitConfig,
}: TokenHandlerOptions): express.Router {
  const router = express.Router();
  router.use(corsWildcard);
  router.use(allowedMethods(["POST"]));
  router.use(express.urlencoded({ extended: false }));

  // Apply rate limiting unless explicitly disabled.
  if (rateLimitConfig !== false) {
    router.use(
      createRateLimiter({
        windowMs: 15 * 60 * 1000, // 15 minutes
        max: 50, // 50 requests per windowMs
        standardHeaders: true,
        legacyHeaders: false,
        message: new TooManyRequestsError(
          "You have exceeded the rate limit for token requests",
        ).toResponseObject(),
        ...rateLimitConfig,
      }),
    );
  }

  router.post("/", async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      const client = await authenticateClient(provider.clientsStore, request.body);

      const parseResult = TokenRequestSchema.safeParse(request.body);
      if (!parseResult.success) {
        throw new InvalidRequestError(parseResult.error.message);
      }
      const { grant_type: grantType } = parseResult.data;

      switch (grantType) {
        case "authorization_code": {
          const grantParse = AuthorizationCodeGrantSchema.safeParse(request.body);
          if (!grantParse.success) {
            throw new InvalidRequestError(grantParse.error.message);
          }
          const {
            code,
            code_verifier: codeVerifier,
            redirect_uri: redirectUri,
            resource,
          } = grantParse.data;
          const skipLocalPkceValidation = provider.skipLocalPkceValidation;
          // Perform local PKCE validation unless explicitly skipped.
          if (!skipLocalPkceValidation) {
            const codeChallenge = await provider.challengeForAuthorizationCode(client, code);
            if (!verifyChallenge(codeVerifier, codeChallenge)) {
              throw new InvalidGrantError("code_verifier does not match the challenge");
            }
          }
          const tokens = await provider.exchangeAuthorizationCode(
            client,
            code,
            skipLocalPkceValidation ? codeVerifier : undefined,
            redirectUri,
            resource ? new URL(resource) : undefined,
          );
          response.status(200).json(tokens satisfies OAuthTokens);
          break;
        }
        case "refresh_token": {
          const grantParse = RefreshTokenGrantSchema.safeParse(request.body);
          if (!grantParse.success) {
            throw new InvalidRequestError(grantParse.error.message);
          }
          const { refresh_token: refreshToken, scope, resource } = grantParse.data;
          const requestedScopes = scope?.split(" ");
          const tokens = await provider.exchangeRefreshToken(
            client,
            refreshToken,
            requestedScopes,
            resource ? new URL(resource) : undefined,
          );
          response.status(200).json(tokens satisfies OAuthTokens);
          break;
        }
        // Additional auth methods will not be added on the server side.
        default:
          throw new UnsupportedGrantTypeError(
            "The grant type is not supported by this authorization server.",
          );
      }
    } catch (error) {
      if (error instanceof OAuthError) {
        const status = error instanceof ServerError ? 500 : 400;
        response.status(status).json(error.toResponseObject());
      } else {
        response.status(500).json(new ServerError("Internal Server Error").toResponseObject());
      }
    }
  });

  return router;
}
