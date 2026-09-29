import type { Database } from "dofek/db";
import { errors, Provider } from "oidc-provider";
import { z } from "zod";
import { logger } from "../../logger.ts";
import { getMcpIssuerUrl, getMcpResourceUrl } from "../oauth-config.ts";
import { MCP_OAUTH_OFFLINE_ACCESS_SCOPE, MCP_OAUTH_SCOPES } from "../oauth-provider.ts";
import { findAccount } from "./account.ts";
import { createMcpOidcAdapter } from "./adapter.ts";
import { escapeHtml, interactionUrl } from "./interactions.ts";

/**
 * oidc-provider-backed OAuth 2.1 authorization server for Dofek's MCP endpoint.
 *
 * This replaces the removed hand-rolled authorization server (RFC 8414 / OAuth
 * 2.1). oidc-provider is a Koa application; `provider.callback()` returns a Node
 * `(req, res)` handler that is mounted by the Express app (see `oauth-route.ts`).
 *
 * Key configuration choices:
 *   - OAuth-only AS: we deliberately omit the `openid` scope and disable
 *     `userinfo`/id_token concerns. Dofek's MCP client is an OAuth 2.1 client;
 *     `openid` is NOT mandatory for the authorization_code grant with
 *     resource-scoped access tokens.
 *   - `registration` enables DCR (RFC 7591) at `/register`.
 *   - `clientIdMetadataDocument` enables CIMD (URL `client_id`), advertising
 *     `client_id_metadata_document_supported` in discovery metadata.
 *   - `resourceIndicators` (RFC 8707) echoes the `resource` parameter into the
 *     access token `aud` via `getResourceServerInfo`.
 *   - `authorization_response_iss_parameter_supported` and RFC 9207 `iss`
 *     echoing are oidc-provider defaults (always emitted), so no feature flag
 *     is required.
 *   - `ciba`, `deviceFlow`, `pushedAuthorizationRequests`, `dPoP`,
 *     `clientCredentials`, and `introspection` are disabled: Dofek has no
 *     backchannel/push device flow, and DPoP would require provisioning a
 *     nonce secret with no current consumer.
 */

export interface OidcProviderOptions {
  /**
   * Stable signing keys for oidc-provider's short-lived interaction cookies.
   * Rotating these invalidates in-flight authorization requests.
   */
  cookiesKeys: string[];
}

export interface OidcProviderHandle {
  provider: Provider;
}

const diagnosticErrorSchema = z.object({
  cause: z.unknown().optional(),
  error: z.unknown().optional(),
  error_description: z.unknown().optional(),
  error_detail: z.unknown().optional(),
  message: z.unknown().optional(),
  name: z.unknown().optional(),
  status: z.unknown().optional(),
  statusCode: z.unknown().optional(),
});

const tokenRequestSchema = z.object({
  headers: z.object({ authorization: z.unknown().optional() }).optional(),
  oidc: z
    .object({
      client: z.object({ clientAuthMethod: z.unknown() }).optional(),
      params: z
        .object({
          client_assertion: z.unknown().optional(),
          client_secret: z.unknown().optional(),
        })
        .optional(),
    })
    .optional(),
});

const registeredClientAuthMethodSchema = z.enum([
  "none",
  "client_secret_basic",
  "client_secret_post",
  "client_secret_jwt",
  "private_key_jwt",
  "tls_client_auth",
  "self_signed_tls_client_auth",
  "attest_jwt_client_auth",
]);

function tokenClientAuthFields(context: unknown): {
  presented_client_auth?: string;
  registered_client_auth?: string;
} {
  const parsed = tokenRequestSchema.safeParse(context);
  if (!parsed.success) return {};

  const { headers, oidc } = parsed.data;
  const registered = registeredClientAuthMethodSchema.safeParse(oidc?.client?.clientAuthMethod);
  const params = oidc?.params;
  if (!params) {
    return registered.success ? { registered_client_auth: registered.data } : {};
  }

  const presented = params.client_secret
    ? "client_secret_post"
    : typeof headers?.authorization === "string"
      ? headers.authorization.toLowerCase().startsWith("basic ")
        ? "client_secret_basic"
        : "authorization_header"
      : params.client_assertion !== undefined
        ? "client_assertion"
        : "none";

  return {
    presented_client_auth: presented,
    ...(registered.success ? { registered_client_auth: registered.data } : {}),
  };
}

function diagnosticErrorFields(error: unknown): {
  error_name: string;
  error_description: string;
  error_detail?: string;
  error_cause?: string;
  http_status?: number;
  oauth_error?: string;
} {
  const parsed = diagnosticErrorSchema.safeParse(error);
  const fields = parsed.success ? parsed.data : {};
  const safeLabel = (candidate: unknown, fallback: string): string =>
    typeof candidate === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(candidate)
      ? candidate
      : fallback;
  const description =
    typeof fields.error_description === "string"
      ? fields.error_description
      : typeof fields.message === "string"
        ? fields.message
        : "Unknown OAuth error";
  const safeDescription = description
    .replace(/\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[redacted]")
    .replace(
      /\b(client_assertion|client_secret|code|access_token|refresh_token|authorization)=[^\s;,]+/gi,
      "$1=[redacted]",
    )
    .replace(/(https?:\/\/[^\s?#]+)\?[^\s#)]*/gi, "$1?[redacted]")
    .slice(0, 300);
  const statusResult = z.number().safeParse(fields.status);
  const statusCodeResult = z.number().safeParse(fields.statusCode);
  const status = statusResult.success
    ? statusResult.data
    : statusCodeResult.success
      ? statusCodeResult.data
      : undefined;
  const detail =
    typeof fields.error_detail === "string" &&
    !fields.error_detail.includes("=") &&
    !fields.error_detail.includes('"') &&
    !fields.error_detail.includes("'")
      ? fields.error_detail
          .replace(/\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[redacted]")
          .replace(/https?:\/\/[^\s;,]+/g, "[redacted URL]")
          .replace(/\b[A-Za-z0-9_-]{24,}\b/g, "[redacted]")
          .slice(0, 160)
      : undefined;
  const causeName =
    fields.cause instanceof Error ? safeLabel(fields.cause.name, "Error") : undefined;

  return {
    error_name: safeLabel(fields.name, "Error"),
    error_description: safeDescription,
    ...(detail ? { error_detail: detail } : {}),
    ...(causeName ? { error_cause: causeName } : {}),
    ...(typeof status === "number" ? { http_status: status } : {}),
    ...(typeof fields.error === "string"
      ? { oauth_error: safeLabel(fields.error, "unknown") }
      : {}),
  };
}

export function createOidcProvider(
  db: Pick<Database, "execute">,
  options: OidcProviderOptions,
): OidcProviderHandle {
  const issuer = getMcpIssuerUrl().href;
  const resourceUrl = getMcpResourceUrl().href;

  const provider = new Provider(issuer, {
    scopes: [...MCP_OAUTH_SCOPES, MCP_OAUTH_OFFLINE_ACCESS_SCOPE],

    features: {
      ciba: { enabled: false },
      clientCredentials: { enabled: false },
      clientIdMetadataDocument: {
        ack: "draft-02",
        enabled: true,
      },
      deviceFlow: { enabled: false },
      devInteractions: { enabled: false },
      dPoP: { enabled: false },
      introspection: { enabled: false },
      pushedAuthorizationRequests: { enabled: false },
      registration: {
        enabled: true,
        initialAccessToken: false,
      },
      resourceIndicators: {
        enabled: true,
        async defaultResource(): Promise<string> {
          return resourceUrl;
        },
        async getResourceServerInfo(
          _ctx: unknown,
          resourceIndicator: string,
        ): Promise<{
          audience: string;
          scope: string;
          accessTokenFormat: string;
          accessTokenTTL: number;
        }> {
          if (resourceIndicator !== resourceUrl) {
            throw new errors.InvalidTarget();
          }
          return {
            audience: resourceUrl,
            scope: MCP_OAUTH_SCOPES.join(" "),
            accessTokenFormat: "jwt",
            accessTokenTTL: 60 * 60,
          };
        },
      },
      revocation: { enabled: true },
      userinfo: { enabled: false },
    },

    adapter: createMcpOidcAdapter(db),

    ttl: {
      RefreshToken: 30 * 24 * 60 * 60,
      Grant: 30 * 24 * 60 * 60,
    },
    rotateRefreshToken: () => true,

    findAccount(ctx, accountId) {
      return findAccount(db, ctx, accountId);
    },

    interactions: {
      url: interactionUrl,
    },

    routes: {
      authorization: "/authorize",
      registration: "/register",
      revocation: "/revoke",
      token: "/token",
    },

    cookies: {
      keys: options.cookiesKeys,
    },

    clientBasedCORS(_ctx: unknown, _origin: unknown, client: unknown) {
      return client !== undefined;
    },

    renderError(ctx: { type: string; body: string }, _out: unknown, error: { message: string }) {
      ctx.type = "html";
      const message = escapeHtml(error.message);
      ctx.body = `<!doctype html><html><head><title>Authorization error</title></head><body><h1>Authorization error</h1><p>${message}</p></body></html>`;
    },
  });
  provider.proxy = true;

  provider.on("grant.error", (context, error) => {
    logger.warn("mcp.oidc.token_exchange_failed", {
      ...diagnosticErrorFields(error),
      ...tokenClientAuthFields(context),
    });
  });

  return { provider };
}
