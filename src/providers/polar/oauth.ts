import type { OAuthConfig } from "../../auth/oauth.ts";
import { getOAuthRedirectUri } from "../../auth/oauth.ts";

export const POLAR_API_BASE = "https://www.polaraccesslink.com/v3";
export const POLAR_AUTHORIZE_URL = "https://flow.polar.com/oauth2/authorization";
export const POLAR_TOKEN_URL = "https://polarremote.com/v2/oauth2/token";

export function polarOAuthConfig(host?: string): OAuthConfig | null {
  const clientId = process.env.POLAR_CLIENT_ID;
  const clientSecret = process.env.POLAR_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  return {
    clientId,
    clientSecret,
    authorizeUrl: POLAR_AUTHORIZE_URL,
    tokenUrl: POLAR_TOKEN_URL,
    redirectUri: getOAuthRedirectUri(host),
    scopes: ["accesslink.read_all"],
    tokenAuthMethod: "basic",
  };
}
