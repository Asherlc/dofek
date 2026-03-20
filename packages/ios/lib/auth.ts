import {
  AuthUserSchema,
  ConfiguredProvidersSchema,
  type AuthUser,
  type ConfiguredProviders,
} from "@dofek/auth/auth";
import * as SecureStore from "expo-secure-store";
import * as WebBrowser from "expo-web-browser";

export { AuthUserSchema, ConfiguredProvidersSchema };
export type { AuthUser, ConfiguredProviders };

const SESSION_TOKEN_KEY = "dofek_session_token";
const APP_SCHEME = "dofek";

/** Save the session token to secure storage. */
export async function saveSessionToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(SESSION_TOKEN_KEY, token);
}

/** Get the saved session token, or null if not logged in. */
export async function getSessionToken(): Promise<string | null> {
  return SecureStore.getItemAsync(SESSION_TOKEN_KEY);
}

/** Clear the session token (logout). */
export async function clearSessionToken(): Promise<void> {
  await SecureStore.deleteItemAsync(SESSION_TOKEN_KEY);
}

/** Validate the stored session token by calling /api/auth/me. Returns the user or null. */
export async function fetchCurrentUser(
  serverUrl: string,
  token: string,
): Promise<AuthUser | null> {
  try {
    const res = await fetch(`${serverUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const data: unknown = await res.json();
    return AuthUserSchema.parse(data);
  } catch {
    return null;
  }
}

/** Fetch available login providers from the server. */
export async function fetchConfiguredProviders(
  serverUrl: string,
): Promise<ConfiguredProviders> {
  const res = await fetch(`${serverUrl}/api/auth/providers`);
  if (!res.ok) {
    throw new Error(`Failed to fetch providers: ${res.status} ${res.statusText}`);
  }
  const data: unknown = await res.json();
  return ConfiguredProvidersSchema.parse(data);
}

/** Start OAuth login via system browser. Returns the session token on success, null if cancelled. */
export async function startOAuthLogin(
  serverUrl: string,
  providerId: string,
  isDataProvider: boolean,
): Promise<string | null> {
  const loginPath = isDataProvider
    ? `/auth/login/data/${providerId}`
    : `/auth/login/${providerId}`;
  const loginUrl = `${serverUrl}${loginPath}?redirect_scheme=${APP_SCHEME}`;
  const redirectUrl = `${APP_SCHEME}://auth/callback`;

  const result = await WebBrowser.openAuthSessionAsync(loginUrl, redirectUrl);

  if (result.type !== "success") {
    return null;
  }

  // Extract session token from the redirect URL
  const url = new URL(result.url);
  const session = url.searchParams.get("session");
  return session;
}

/** Log out: delete session on server and clear local token. */
export async function logout(serverUrl: string, token: string): Promise<void> {
  try {
    await fetch(`${serverUrl}/auth/logout`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    // Best-effort — clear local state regardless
  }
  await clearSessionToken();
}
