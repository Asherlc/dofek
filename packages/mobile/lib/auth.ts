import {
  type AuthUser,
  AuthUserSchema,
  type ConfiguredProviders,
  ConfiguredProvidersSchema,
} from "@dofek/auth/auth";
import * as AppleAuthentication from "expo-apple-authentication";
import * as SecureStore from "expo-secure-store";
import * as WebBrowser from "expo-web-browser";
import { Platform } from "react-native";
import { z } from "zod";
import { captureException } from "./telemetry";

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
export async function fetchCurrentUser(serverUrl: string, token: string): Promise<AuthUser | null> {
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
export async function fetchConfiguredProviders(serverUrl: string): Promise<ConfiguredProviders> {
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
  const loginPath = isDataProvider ? `/auth/login/data/${providerId}` : `/auth/login/${providerId}`;
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

/** Whether native Apple Sign In is available (iOS 13+). */
export async function isNativeAppleSignInAvailable(): Promise<boolean> {
  if (Platform.OS !== "ios" || AppleAuthentication.isAvailableAsync === undefined) {
    return false;
  }

  try {
    return await AppleAuthentication.isAvailableAsync();
  } catch (error: unknown) {
    captureException(error, { source: "apple-auth-availability" });
    return false;
  }
}

/** Sign in using the native iOS Apple Sign In sheet. Returns session token or null if cancelled. */
export async function startNativeAppleSignIn(serverUrl: string): Promise<string | null> {
  const credential = await AppleAuthentication.signInAsync({
    requestedScopes: [
      AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
      AppleAuthentication.AppleAuthenticationScope.EMAIL,
    ],
  });

  if (!credential.authorizationCode) {
    return null;
  }

  const body: Record<string, string> = {
    authorizationCode: credential.authorizationCode,
  };
  if (credential.identityToken) {
    body.identityToken = credential.identityToken;
  }
  if (credential.fullName?.givenName) {
    body.givenName = credential.fullName.givenName;
  }
  if (credential.fullName?.familyName) {
    body.familyName = credential.fullName.familyName;
  }

  const response = await fetch(`${serverUrl}/auth/apple/native`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Apple Sign In failed: ${response.status}`);
  }

  const data: unknown = await response.json();
  const parsed = z.object({ session: z.string() }).safeParse(data);
  return parsed.success ? parsed.data.session : null;
}

/** Log out: delete session on server and clear local token. */
export async function logout(serverUrl: string, token: string): Promise<void> {
  try {
    await fetch(`${serverUrl}/auth/logout`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (error: unknown) {
    captureException(error, { source: "logout" });
  }
  await clearSessionToken();
}
