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
