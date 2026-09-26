import { randomBytes, randomUUID } from "node:crypto";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import {
  InvalidClientMetadataError,
  MethodNotAllowedError,
  OAuthError,
  ServerError,
  TooManyRequestsError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import {
  type OAuthClientInformationFull,
  OAuthClientMetadataSchema,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import express from "express";
import {
  rateLimit as createRateLimiter,
  type Options as RateLimitOptions,
} from "express-rate-limit";

const DEFAULT_CLIENT_SECRET_EXPIRY_SECONDS = 30 * 24 * 60 * 60; // 30 days

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

export interface ClientRegistrationHandlerOptions {
  clientsStore: OAuthRegisteredClientsStore;
  clientSecretExpirySeconds?: number;
  rateLimit?: Partial<RateLimitOptions> | false;
}

export function clientRegistrationHandler({
  clientsStore,
  clientSecretExpirySeconds = DEFAULT_CLIENT_SECRET_EXPIRY_SECONDS,
  rateLimit: rateLimitConfig,
}: ClientRegistrationHandlerOptions): express.Router {
  if (!clientsStore.registerClient) {
    throw new Error("Client registration store does not support registering clients");
  }
  const registerClient = clientsStore.registerClient;
  const router = express.Router();
  router.use(corsWildcard);
  router.use(allowedMethods(["POST"]));
  router.use(express.json());

  // Apply rate limiting unless explicitly disabled — stricter limits for registration.
  if (rateLimitConfig !== false) {
    router.use(
      createRateLimiter({
        windowMs: 60 * 60 * 1000, // 1 hour
        max: 20, // 20 requests per hour
        standardHeaders: true,
        legacyHeaders: false,
        message: new TooManyRequestsError(
          "You have exceeded the rate limit for client registration requests",
        ).toResponseObject(),
        ...rateLimitConfig,
      }),
    );
  }

  router.post("/", async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      const parseResult = OAuthClientMetadataSchema.safeParse(request.body);
      if (!parseResult.success) {
        throw new InvalidClientMetadataError(parseResult.error.message);
      }
      const clientMetadata = parseResult.data;
      const isPublicClient = clientMetadata.token_endpoint_auth_method === "none";
      const clientSecret = isPublicClient ? undefined : randomBytes(32).toString("hex");
      const clientIdIssuedAt = Math.floor(Date.now() / 1000);
      const clientsDoExpire = clientSecretExpirySeconds > 0;
      const secretExpiryTime = clientsDoExpire ? clientIdIssuedAt + clientSecretExpirySeconds : 0;
      const clientSecretExpiresAt = isPublicClient ? undefined : secretExpiryTime;

      const clientInfo: OAuthClientInformationFull = {
        ...clientMetadata,
        client_id: randomUUID(),
        client_id_issued_at: clientIdIssuedAt,
        client_secret: clientSecret,
        client_secret_expires_at: clientSecretExpiresAt,
      };

      const registeredClient = await registerClient(clientInfo);
      response.status(201).json(registeredClient);
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
