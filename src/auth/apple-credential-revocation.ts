import { createAppleClientSecret, decodePemToDer } from "./apple-client-secret.ts";
import { getApplePrivateKey } from "./apple-private-key.ts";

export interface AppleRevocationCredential {
  accessToken: string;
  clientId: string;
  refreshToken: string | null;
}

function requiredEnvironmentValue(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for Apple credential revocation`);
  return value;
}

export async function revokeAppleCredential(
  credential: AppleRevocationCredential,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<void> {
  const clientSecret = await createAppleClientSecret(
    requiredEnvironmentValue("APPLE_TEAM_ID"),
    requiredEnvironmentValue("APPLE_KEY_ID"),
    decodePemToDer(getApplePrivateKey()),
    credential.clientId,
  );
  const token = credential.refreshToken ?? credential.accessToken;
  const tokenTypeHint = credential.refreshToken ? "refresh_token" : "access_token";
  const body = new URLSearchParams({
    client_id: credential.clientId,
    client_secret: clientSecret,
    token,
    token_type_hint: tokenTypeHint,
  });
  const response = await fetchFn("https://appleid.apple.com/auth/revoke", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });
  if (response.ok) return;
  throw new Error(`Apple credential revocation failed (${response.status})`);
}
