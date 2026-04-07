import type { OAuthConfig } from "../../auth/oauth.ts";
import { getOAuthRedirectUri } from "../../auth/oauth.ts";
import { OURA_API_BASE } from "./client.ts";

export function ouraOAuthConfig(host?: string): OAuthConfig | null {
  const clientId = process.env.OURA_CLIENT_ID;
  const clientSecret = process.env.OURA_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  return {
    clientId,
    clientSecret,
    authorizeUrl: "https://cloud.ouraring.com/oauth/authorize",
    tokenUrl: `${OURA_API_BASE}/oauth/token`,
    redirectUri: getOAuthRedirectUri(host),
    scopes: [
      "daily",
      "email",
      "heartrate",
      "heart_health",
      "personal",
      "session",
      "spo2",
      "stress",
      "workout",
      "tag",
    ],
  };
}

export function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
