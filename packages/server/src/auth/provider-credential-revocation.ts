import * as Sentry from "@sentry/node";
import { type OAuthConfig, revokeToken, type TokenSet } from "dofek/auth/oauth";
import { logger } from "../logger.ts";

interface RevokeProviderCredentialsInput {
  oauthConfig?: OAuthConfig | undefined;
  providerId: string;
  revokeExistingTokens?: ((tokens: TokenSet) => Promise<void>) | undefined;
  tokens: TokenSet;
}

export async function revokeProviderCredentials(
  input: RevokeProviderCredentialsInput,
): Promise<void> {
  if (input.revokeExistingTokens) {
    try {
      await input.revokeExistingTokens(input.tokens);
      return;
    } catch (error: unknown) {
      logger.warn(
        `[auth] Custom revocation failed for superseded ${input.providerId} authorization: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      Sentry.captureException(error, {
        tags: {
          source: "provider-credential-revocation",
          operation: "custom-revocation",
          providerId: input.providerId,
        },
      });
      if (!input.oauthConfig?.revokeUrl) throw error;
    }
  }

  if (!input.oauthConfig?.revokeUrl) {
    throw new Error(`Provider ${input.providerId} has no credential revocation policy`);
  }

  const errors: string[] = [];
  for (const [tokenType, token] of [
    ["access", input.tokens.accessToken],
    ["refresh", input.tokens.refreshToken],
  ] as const) {
    if (!token) continue;
    try {
      await revokeToken(input.oauthConfig, token);
    } catch (error: unknown) {
      const message = `${tokenType} token revocation failed: ${
        error instanceof Error ? error.message : String(error)
      }`;
      logger.error(`[auth] ${input.providerId} ${message}`);
      Sentry.captureException(error, {
        tags: {
          source: "provider-credential-revocation",
          operation: "standard-revocation",
          providerId: input.providerId,
          tokenType,
        },
      });
      errors.push(message);
    }
  }
  if (errors.length > 0) {
    throw new Error(`Failed to revoke ${input.providerId} credentials: ${errors.join("; ")}`);
  }
}
