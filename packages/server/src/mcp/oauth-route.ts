import {
  createOAuthMetadata,
  mcpAuthRouter,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import type { Database } from "dofek/db";
import express, { Router } from "express";
import {
  rateLimit as createRateLimiter,
  type Options as RateLimitOptions,
} from "express-rate-limit";
import { z } from "zod";
import { getSessionIdFromRequest } from "../auth/cookies.ts";
import { validateSession } from "../auth/session.ts";
import { getMcpIssuerUrl, getMcpResourceUrl } from "./oauth-config.ts";
import { DofekOAuthServerProvider, MCP_OAUTH_SCOPES } from "./oauth-provider.ts";

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
  const provider = new DofekOAuthServerProvider(db, resourceUrl);
  const oauthRouterOptions = {
    issuerUrl,
    provider,
    resourceName: "Dofek",
    resourceServerUrl: resourceUrl,
    scopesSupported: [...MCP_OAUTH_SCOPES],
  };

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

  const rateLimitOptions = { rateLimit };
  const metadataRateLimit = rateLimit === false ? [] : [createRateLimiter(rateLimit)];
  router.get(
    "/.well-known/oauth-authorization-server",
    ...metadataRateLimit,
    (_request, response) => {
      response.json({
        ...createOAuthMetadata(oauthRouterOptions),
        client_id_metadata_document_supported: true,
      });
    },
  );

  router.use(
    mcpAuthRouter({
      ...oauthRouterOptions,
      authorizationOptions: rateLimitOptions,
      clientRegistrationOptions: rateLimitOptions,
      revocationOptions: rateLimitOptions,
      tokenOptions: rateLimitOptions,
    }),
  );
  return router;
}
