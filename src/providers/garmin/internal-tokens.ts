import type { GarminTokens } from "@dofek/garmin-connect/types";
import { z } from "zod";
import type { TokenSet } from "../../auth/oauth.ts";

export const INTERNAL_SCOPE_MARKER = "garmin-connect-internal";

const garminTokensSchema = z.object({
  oauth1: z.object({
    oauth_token: z.string(),
    oauth_token_secret: z.string(),
    mfa_token: z.string().optional(),
    mfa_expiration_timestamp: z.string().optional(),
  }),
  oauth2: z.object({
    scope: z.string(),
    jti: z.string(),
    token_type: z.string(),
    access_token: z.string(),
    refresh_token: z.string(),
    expires_in: z.number(),
    expires_at: z.number(),
    refresh_token_expires_in: z.number(),
    refresh_token_expires_at: z.number(),
  }),
  displayName: z.string().optional(),
});

export function serializeInternalTokens(tokens: GarminTokens): TokenSet {
  return {
    accessToken: JSON.stringify(tokens),
    refreshToken: null,
    expiresAt: new Date(tokens.oauth2.expires_at * 1000),
    scopes: INTERNAL_SCOPE_MARKER,
  };
}

export function deserializeInternalTokens(stored: TokenSet): GarminTokens | null {
  try {
    const parsed: unknown = JSON.parse(stored.accessToken);
    const result = garminTokensSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
