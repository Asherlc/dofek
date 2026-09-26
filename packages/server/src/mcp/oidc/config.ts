import type { Database } from "dofek/db";
import { errors, Provider } from "oidc-provider";
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

  return { provider };
}
