import type { OAuth2Tokens } from "arctic";
import { revokeAppleCredential } from "dofek/auth/apple-credential-revocation";
import { z } from "zod";
import type { IdentityProviderName } from "./providers.ts";
import { appleRevocationCredentialFromTokens } from "./providers.ts";

const googleRevocationErrorSchema = z.object({ error: z.string() });

export async function revokeIdentityCredentials(
  providerName: IdentityProviderName,
  tokens: OAuth2Tokens,
  appleClientId?: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<void> {
  if (providerName === "apple") {
    if (!appleClientId) {
      throw new Error("APPLE_CLIENT_ID is required for Apple credential revocation");
    }
    await revokeAppleCredential(
      appleRevocationCredentialFromTokens(tokens, appleClientId),
      fetchFn,
    );
    return;
  }

  const token = tokens.hasRefreshToken() ? tokens.refreshToken() : tokens.accessToken();
  const response = await fetchFn("https://oauth2.googleapis.com/revoke", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ token }).toString(),
  });
  if (response.ok) return;
  const responseBody: unknown = await response.json();
  const parsedError = googleRevocationErrorSchema.parse(responseBody);
  if (response.status === 400 && parsedError.error === "invalid_token") {
    return;
  }
  throw new Error(`Google credential revocation failed (${response.status}): ${parsedError.error}`);
}
