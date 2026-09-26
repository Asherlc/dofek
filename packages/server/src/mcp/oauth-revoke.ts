import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import {
  InvalidClientError,
  InvalidRequestError,
  MethodNotAllowedError,
  OAuthError,
  ServerError,
  TooManyRequestsError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import {
  type OAuthClientInformationFull,
  OAuthTokenRevocationRequestSchema,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import express from "express";
import {
  rateLimit as createRateLimiter,
  type Options as RateLimitOptions,
} from "express-rate-limit";
import { z } from "zod";

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

export interface RevocationHandlerOptions {
  provider: OAuthServerProvider;
  rateLimit?: Partial<RateLimitOptions> | false;
}

export function revocationHandler({
  provider,
  rateLimit: rateLimitConfig,
}: RevocationHandlerOptions): express.Router {
  if (!provider.revokeToken) {
    throw new Error("Auth provider does not support revoking tokens");
  }
  const revokeToken = provider.revokeToken;
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
          "You have exceeded the rate limit for token revocation requests",
        ).toResponseObject(),
        ...rateLimitConfig,
      }),
    );
  }

  router.post("/", async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      const client = await authenticateClient(provider.clientsStore, request.body);
      const parseResult = OAuthTokenRevocationRequestSchema.safeParse(request.body);
      if (!parseResult.success) {
        throw new InvalidRequestError(parseResult.error.message);
      }
      await revokeToken(client, parseResult.data);
      response.status(200).json({});
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
