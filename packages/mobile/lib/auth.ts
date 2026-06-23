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

export interface AuthResult {
  session: string;
  isNewUser: boolean;
}

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

async function submitPasswordAuth(
  serverUrl: string,
  path: "/auth/login/password" | "/auth/register",
  body: Record<string, string | undefined>,
): Promise<AuthResult> {
  const response = await fetch(`${serverUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });

  const data: unknown = await response.json().catch(() => null);
  const parsed = z
    .object({
      session: z.string(),
      isNewUser: z.boolean(),
      error: z.string().optional(),
    })
    .safeParse(data);
  const errorParsed = z.object({ error: z.string().optional() }).safeParse(data);

  if (!response.ok) {
    throw new Error(
      errorParsed.success && errorParsed.data.error
        ? errorParsed.data.error
        : "Authentication failed",
    );
  }
  if (!parsed.success || !parsed.data.session) {
    throw new Error("Authentication failed");
  }
  return { session: parsed.data.session, isNewUser: parsed.data.isNewUser };
}

export async function loginWithPassword(
  serverUrl: string,
  email: string,
  password: string,
): Promise<AuthResult> {
  return submitPasswordAuth(serverUrl, "/auth/login/password", { email, password });
}

export async function registerWithPassword(
  serverUrl: string,
  email: string,
  password: string,
  name?: string,
): Promise<AuthResult> {
  return submitPasswordAuth(serverUrl, "/auth/register", {
    email,
    password,
    name,
  });
}

const PasswordResetResponseSchema = z.object({
  error: z.string().optional(),
  message: z.string(),
});

export async function requestPasswordReset(
  serverUrl: string,
  email: string,
): Promise<{ message: string }> {
  const response = await fetch(`${serverUrl}/auth/password-reset/request`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ email }),
  });
  const data: unknown = await response.json().catch(() => null);
  const parsed = PasswordResetResponseSchema.safeParse(data);
  if (!response.ok) {
    throw new Error(
      parsed.success && parsed.data.error ? parsed.data.error : "Password reset failed",
    );
  }
  if (!parsed.success) {
    throw new Error("Password reset failed");
  }
  return { message: parsed.data.message };
}

/** Start OAuth login via system browser. Returns the auth result on success, null if cancelled. */
export async function startOAuthLogin(
  serverUrl: string,
  providerId: string,
  isDataProvider: boolean,
): Promise<AuthResult | null> {
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
  const newUserParam = url.searchParams.get("new_user");
  if (!session) return null;
  if (newUserParam !== "true" && newUserParam !== "false") {
    throw new Error("Authentication failed");
  }
  return {
    session,
    isNewUser: newUserParam === "true",
  };
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

/** Sign in using the native iOS Apple Sign In sheet. Returns auth result or null if cancelled. */
export async function startNativeAppleSignIn(serverUrl: string): Promise<AuthResult | null> {
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
  const parsed = z.object({ session: z.string(), isNewUser: z.boolean() }).safeParse(data);
  if (!parsed.success) {
    throw new Error("Apple Sign In failed: invalid response");
  }
  return { session: parsed.data.session, isNewUser: parsed.data.isNewUser };
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
