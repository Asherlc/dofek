import type { Database } from "dofek/db";
import express, { Router } from "express";
import {
  rateLimit as createRateLimiter,
  type Options as RateLimitOptions,
} from "express-rate-limit";
import { z } from "zod";
import { getSessionIdFromRequest } from "../auth/cookies.ts";
import { validateSession } from "../auth/session.ts";
import { McpOAuthClientsStore } from "./oauth-client-store.ts";
import { getMcpIssuerUrl, getMcpResourceUrl } from "./oauth-config.ts";
import { createProtectedResourceMetadata } from "./oauth-metadata.ts";
import { MCP_OAUTH_SUPPORTED_SCOPES } from "./oauth-provider.ts";

export type McpAuthRateLimitOptions = Partial<RateLimitOptions> | false;

/** Shared by /authorize so consent form posts parse as flat string fields. */
export const mcpAuthorizeUrlencodedOptions = { extended: false } as const;

const approvalBodySchema = z.object({
  approval: z.string().min(1).optional(),
});

export function approvalFromBody(body: unknown): string | undefined {
  const result = approvalBodySchema.safeParse(body);
  return result.success ? result.data.approval : undefined;
}

export function createMcpOAuthRouter(
  db: Pick<Database, "execute">,
  rateLimit?: McpAuthRateLimitOptions,
): Router {
  const router = Router();
  const issuerUrl = getMcpIssuerUrl();
  const resourceUrl = getMcpResourceUrl();
  const scopesSupported = [...MCP_OAUTH_SUPPORTED_SCOPES];

  router.use(
    "/authorize",
    express.urlencoded(mcpAuthorizeUrlencodedOptions),
    async (request, response, next) => {
      response.set("Content-Security-Policy", "frame-ancestors 'none'");
      response.set("X-Frame-Options", "DENY");
      const sessionId = getSessionIdFromRequest(request);
      const session = sessionId ? await validateSession(db, sessionId) : null;
      if (!session) {
        const loginSearch = new URLSearchParams({ returnTo: request.originalUrl });
        response.redirect(`/login?${loginSearch}`);
        return;
      }
      response.locals.mcpOAuthUserId = session.userId;
      response.locals.mcpOAuthApproval = approvalFromBody(request.body);
      next();
    },
  );

  const metadataRateLimit = createRateLimiter({
    ...rateLimit,
    skip: rateLimit === false ? () => true : rateLimit?.skip,
  });

  // Dofek owns the RFC 9728 Protected Resource Metadata (the resource-server
  // role). The authorization-server metadata and endpoints are served by the
  // dedicated oidc-provider authorization server.
  const protectedResourceMetadata = createProtectedResourceMetadata({
    resourceServerUrl: resourceUrl,
    issuer: issuerUrl.href,
    scopesSupported,
    resourceName: "Dofek",
  });
  router.get(
    "/.well-known/oauth-protected-resource/api/mcp",
    metadataRateLimit,
    (_request, response) => {
      response.json(protectedResourceMetadata);
    },
  );

  // CIMD endpoint for locally registered clients.
  const oauthClientStore = new McpOAuthClientsStore(db);
  router.get("/.well-known/oauth-client", metadataRateLimit, async (_request, response) => {
    response.status(400).json({ error: "Missing clientId" });
  });
  router.get(
    "/.well-known/oauth-client/:clientId",
    metadataRateLimit,
    async (request, response) => {
      const rawClientId = Array.isArray(request.params.clientId)
        ? request.params.clientId[0]
        : request.params.clientId;
      const clientId: string = rawClientId ?? "";
      const client = await oauthClientStore.getClient(clientId);
      if (!client) {
        response.status(404).json({ error: "Client not found" });
        return;
      }
      // CIMD metadata documents must never expose client_secret (RFC 7591 / CIMD spec).
      const { client_secret: _omittedSecret, ...publicClientInfo } = client;
      response.json(publicClientInfo);
    },
  );

  return router;
}
