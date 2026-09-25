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
import { DofekOAuthServerProvider, MCP_OAUTH_SUPPORTED_SCOPES } from "./oauth-provider.ts";
import { McpOAuthClientsStore } from "./oauth-client-store.ts";
import { executeWithSchema } from "../lib/typed-sql.ts";
import { sql } from "drizzle-orm";
import {
  type OAuthClientInformationFull,
  OAuthClientInformationFullSchema,
  OAuthClientMetadataSchema,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  decryptCredentialValue,
  encryptCredentialValue,
} from "dofek/security/credential-encryption";

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
    scopesSupported: [...MCP_OAUTH_SUPPORTED_SCOPES],
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
  const metadataRateLimit = createRateLimiter({
    ...rateLimit,
    skip: rateLimit === false ? () => true : rateLimit?.skip,
  });
  router.get("/.well-known/oauth-authorization-server", metadataRateLimit, (_request, response) => {
    response.json({
      ...createOAuthMetadata(oauthRouterOptions),
      client_id_metadata_document_supported: true,
    });
  });

  // CIMD endpoint for locally registered clients
  const oauthClientStore = new McpOAuthClientsStore(db);
  const oauthClientRowSchema = z.object({
    client_id: z.string(),
    client_secret: z.string().nullable(),
    client_metadata: OAuthClientMetadataSchema,
    client_id_issued_at: z.coerce.number().nullable(),
    client_secret_expires_at: z.coerce.number().nullable(),
  });
  function clientSecretContext(clientId: string) {
    return {
      columnName: "client_secret",
      scopeId: clientId,
      tableName: "fitness.mcp_oauth_client",
    };
  }
  router.get("/.well-known/oauth-client/:clientId", metadataRateLimit, async (request, response) => {
    const clientId = Array.isArray(request.params.clientId) ? request.params.clientId[0] : request.params.clientId;
    if (!clientId) {
      response.status(400).json({ error: "Missing clientId" });
      return;
    }
    const rows = await executeWithSchema(
      db,
      oauthClientRowSchema,
      sql`SELECT client_id, client_secret, client_metadata, client_id_issued_at,
                 client_secret_expires_at
          FROM fitness.mcp_oauth_client
          WHERE client_id = ${clientId}
          LIMIT 1`,
    );
    const row = rows[0];
    if (!row) {
      response.status(404).json({ error: "Client not found" });
      return;
    }
    const clientSecret = row.client_secret
      ? await decryptCredentialValue(row.client_secret, clientSecretContext(clientId))
      : undefined;
    const client: OAuthClientInformationFull = OAuthClientInformationFullSchema.parse({
      ...row.client_metadata,
      client_id: row.client_id,
      client_id_issued_at: row.client_id_issued_at ?? undefined,
      client_secret: clientSecret,
      client_secret_expires_at: row.client_secret_expires_at ?? undefined,
    });
    response.json(client);
  });

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
