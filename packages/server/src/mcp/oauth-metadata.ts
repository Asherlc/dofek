import type { OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";

/**
 * Check for dev mode flag that allows HTTP issuer URLs (for development/testing only).
 * Mirrored from the MCP SDK so Dofek-issued metadata enforces the same HTTPS
 * requirement for the issuer identifier (RFC 8414).
 */
const allowInsecureIssuerUrl =
  process.env.MCP_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL === "true" ||
  process.env.MCP_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL === "1";

function checkIssuerUrl(issuer: URL): void {
  // Technically RFC 8414 does not permit a localhost HTTPS exemption, but this
  // is necessary for ease of testing.
  if (
    issuer.protocol !== "https:" &&
    issuer.hostname !== "localhost" &&
    issuer.hostname !== "127.0.0.1" &&
    !allowInsecureIssuerUrl
  ) {
    throw new Error("Issuer URL must be HTTPS");
  }
  if (issuer.hash) {
    throw new Error(`Issuer URL must not have a fragment: ${issuer}`);
  }
  if (issuer.search) {
    throw new Error(`Issuer URL must not have a query string: ${issuer}`);
  }
}

export interface OAuthAuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  response_types_supported: ["code"];
  code_challenge_methods_supported: ["S256"];
  token_endpoint: string;
  token_endpoint_auth_methods_supported: ["client_secret_post", "none"];
  grant_types_supported: ["authorization_code", "refresh_token"];
  scopes_supported: string[];
  revocation_endpoint?: string;
  revocation_endpoint_auth_methods_supported?: ["client_secret_post"];
  registration_endpoint?: string;
  authorization_response_iss_parameter_supported: true;
  client_id_metadata_document_supported: true;
}

export interface OAuthMetadataOptions {
  provider: OAuthServerProvider;
  issuerUrl: URL;
  baseUrl?: URL;
  scopesSupported: readonly string[];
}

/**
 * Builds the OAuth 2.0 Authorization Server Metadata document (RFC 8414) for
 * Dofek's MCP authorization server. Unlike the removed v1 SDK router, this also
 * advertises RFC 9207 issuer identification in authorization responses via
 * `authorization_response_iss_parameter_supported`.
 */
export function createOAuthMetadata(
  options: OAuthMetadataOptions,
): OAuthAuthorizationServerMetadata {
  const issuer = options.issuerUrl;
  const baseUrl = options.baseUrl ?? issuer;
  checkIssuerUrl(issuer);

  const registrationEndpoint = options.provider.clientsStore.registerClient
    ? "/register"
    : undefined;
  const revocationEndpoint = options.provider.revokeToken ? "/revoke" : undefined;

  return {
    issuer: issuer.href,
    authorization_endpoint: new URL("/authorize", baseUrl).href,
    response_types_supported: ["code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint: new URL("/token", baseUrl).href,
    token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    scopes_supported: [...options.scopesSupported],
    revocation_endpoint: revocationEndpoint ? new URL(revocationEndpoint, baseUrl).href : undefined,
    revocation_endpoint_auth_methods_supported: revocationEndpoint
      ? ["client_secret_post"]
      : undefined,
    registration_endpoint: registrationEndpoint
      ? new URL(registrationEndpoint, baseUrl).href
      : undefined,
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: true,
  };
}

export interface ProtectedResourceMetadataOptions {
  resourceServerUrl: URL;
  issuer: string;
  scopesSupported: readonly string[];
  resourceName?: string;
}

export interface OAuthProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported: string[];
  resource_name?: string;
}

/**
 * Builds the RFC 9728 OAuth Protected Resource Metadata document describing the
 * Dofek MCP resource server and the authorization server that can issue tokens
 * for it.
 */
export function createProtectedResourceMetadata(
  options: ProtectedResourceMetadataOptions,
): OAuthProtectedResourceMetadata {
  return {
    resource: options.resourceServerUrl.href,
    authorization_servers: [options.issuer],
    scopes_supported: [...options.scopesSupported],
    resource_name: options.resourceName,
  };
}

/**
 * Constructs the OAuth 2.0 Protected Resource Metadata URL from a given server
 * URL, replacing the path with the standard metadata endpoint.
 */
export function getOAuthProtectedResourceMetadataUrl(serverUrl: URL): string {
  const url = new URL(serverUrl.href);
  const resourcePath = url.pathname && url.pathname !== "/" ? url.pathname : "";
  return new URL(`/.well-known/oauth-protected-resource${resourcePath}`, url).href;
}
