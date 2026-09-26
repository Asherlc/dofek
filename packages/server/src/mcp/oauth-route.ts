import type { Database } from "dofek/db";
import express, { Router } from "express";
import {
  rateLimit as createRateLimiter,
  type Options as RateLimitOptions,
} from "express-rate-limit";
import { McpOAuthClientsStore } from "./oauth-client-store.ts";
import { getMcpIssuerUrl, getMcpResourceUrl } from "./oauth-config.ts";
import { createProtectedResourceMetadata } from "./oauth-metadata.ts";
import { MCP_OAUTH_SUPPORTED_SCOPES } from "./oauth-provider.ts";
import { createOidcProvider } from "./oidc/config.ts";
import { createInteractionHandler } from "./oidc/interactions.ts";

export type McpAuthRateLimitOptions = Partial<RateLimitOptions> | false;

/**
 * oidc-provider request paths. The bridge below only hands these to the Koa
 * application; every other request falls through to the Dofek Express routes
 * (interaction page, protected-resource metadata, CIMD).
 */
const OIDC_ROUTE_PREFIXES = [
  "/authorize",
  "/token",
  "/register",
  "/revoke",
  "/jwks",
  "/userinfo",
  "/device",
  "/backchannel",
  "/request",
  "/.well-known/oauth-authorization-server",
  "/.well-known/openid-configuration",
] as const;

function isOidcRoute(pathname: string): boolean {
  return OIDC_ROUTE_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/**
 * Keys used to sign oidc-provider's short-lived interaction cookies.
 *
 * In production the key MUST come from `MCP_OIDC_COOKIE_KEY` (Infisical); a
 * missing key is a fatal misconfiguration and we hard-fail rather than sign
 * interaction cookies with a public, guessable value. Local/test instances may
 * derive an ephemeral key from the issuer URL so unit tests and `pnpm dev`
 * work without provisioning a secret.
 */
function resolveCookiesKeys(): string[] {
  const configured = process.env.MCP_OIDC_COOKIE_KEY;
  if (configured && configured.trim().length > 0) {
    return [configured.trim()];
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("MCP_OIDC_COOKIE_KEY environment variable is required in production");
  }
  return [getMcpIssuerUrl().href];
}

/**
 * OAuth 2.1 authorization server + protected resource metadata router.
 *
 * The authorization server role (Authorize/Token/Register/Revoke/discovery) is
 * now served by oidc-provider (see `createOidcProvider`). Dofek retains the RFC
 * 9728 Protected Resource Metadata endpoint, which points at the oidc-provider
 * issuer, and the CIMD well-known client document for locally registered
 * clients.
 */
export function createMcpOAuthRouter(
  db: Pick<Database, "execute">,
  rateLimit?: McpAuthRateLimitOptions,
  cookiesKeys: string[] = resolveCookiesKeys(),
): Router {
  const router = Router();
  const issuerUrl = getMcpIssuerUrl();
  const resourceUrl = getMcpResourceUrl();
  const scopesSupported = [...MCP_OAUTH_SUPPORTED_SCOPES];

  const { provider } = createOidcProvider(db, { cookiesKeys });

  // oidc-provider is a Koa app; `callback()` returns a terminal Node handler.
  // Because it never calls Express `next()`, we scope it strictly to the
  // authorization-server paths and pass every other request through to the
  // Dofek-owned routes below.
  const oidcCallback = provider.callback();
  router.use((request, response, next) => {
    if (!isOidcRoute(request.path)) {
      next();
      return;
    }
    oidcCallback(request, response);
  });

  // Dofek-owned consent/login interaction page, gated on the Dofek session
  // cookie (the authorization flow's user-interaction step). The form posts
  // `approval=…` with an application/x-www-form-urlencoded body.
  router.use(
    "/interaction/:uid",
    express.urlencoded({ extended: false }),
    createInteractionHandler(db, provider),
  );

  const metadataRateLimit = createRateLimiter({
    ...rateLimit,
    skip: rateLimit === false ? () => true : rateLimit?.skip,
  });

  // Dofek owns the RFC 9728 Protected Resource Metadata (the resource-server
  // role). The authorization-server metadata is served by oidc-provider.
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
      // CIMD metadata documents must never expose client_secret (RFC 7591 / CIMD).
      const { client_secret: _omittedSecret, ...publicClientInfo } = client;
      response.json(publicClientInfo);
    },
  );

  return router;
}
