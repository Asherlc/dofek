import {
  type AuthUser,
  AuthUserSchema,
  type ConfiguredProviders,
  ConfiguredProvidersSchema,
} from "@dofek/auth/auth";
import {
  HttpResponseError,
  isHttpServerErrorJsonParseFailure,
  isHttpServerErrorStatus,
} from "@dofek/telemetry/handled-failure";
import * as AppleAuthentication from "expo-apple-authentication";
import * as WebBrowser from "expo-web-browser";
import { Platform } from "react-native";
import { z } from "zod";
import { clearSessionToken } from "./auth-session";
import { captureException } from "./telemetry";

export type { AuthUser, ConfiguredProviders };
export { AuthUserSchema, ConfiguredProvidersSchema };

const APP_SCHEME = "dofek";
const ErrorResponseSchema = z.object({ error: z.string().min(1) });
const invalidSessionResponseMessage =
  "The server returned an invalid session response. Please try again.";

function isNativeAppleSignInCancellation(
  error: unknown,
): error is { code: "ERR_REQUEST_CANCELED" } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ERR_REQUEST_CANCELED"
  );
}

async function requestNativeAppleCredential() {
  try {
    return await AppleAuthentication.signInAsync({
      requestedScopes: [
        AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
        AppleAuthentication.AppleAuthenticationScope.EMAIL,
      ],
    });
  } catch (error: unknown) {
    if (isNativeAppleSignInCancellation(error)) {
      return null;
    }
    throw error;
  }
}

export interface AuthResult {
  session: string;
  isNewUser: boolean;
}

/** Validate the stored session token by calling /api/auth/me. Returns the user or null. */
export async function fetchCurrentUser(serverUrl: string, token: string): Promise<AuthUser | null> {
  const res = await fetch(`${serverUrl}/api/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 401 || res.status === 403) return null;
  if (!res.ok) {
    const data: unknown = res.headers.get("content-type")?.includes("application/json")
      ? await res.json().catch((error: unknown) => {
          if (!isHttpServerErrorJsonParseFailure(error, res.status)) {
            captureException(error, { source: "auth-bootstrap-error-json" });
          }
          return null;
        })
      : null;
    const parsed = ErrorResponseSchema.safeParse(data);
    throw new HttpResponseError(
      parsed.success ? parsed.data.error : `Auth bootstrap failed: ${res.status} ${res.statusText}`,
      res.status,
    );
  }
  const data: unknown = await res.json().catch((error: unknown) => {
    captureException(error, { source: "auth-current-user-json" });
    throw new Error(invalidSessionResponseMessage);
  });
  const parsed = AuthUserSchema.safeParse(data);
  if (!parsed.success) {
    captureException(parsed.error, { source: "auth-current-user-schema" });
    throw new Error(invalidSessionResponseMessage);
  }
  return parsed.data;
}

/** Fetch available login providers from the server. */
export async function fetchConfiguredProviders(serverUrl: string): Promise<ConfiguredProviders> {
  const res = await fetch(`${serverUrl}/api/auth/providers`);
  if (!res.ok) {
    throw new HttpResponseError(
      `Failed to fetch providers: ${res.status} ${res.statusText}`,
      res.status,
    );
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

  const data: unknown = await response.json().catch((error: unknown) => {
    if (!isHttpServerErrorJsonParseFailure(error, response.status)) {
      captureException(error, {
        source: "password-auth-response-json",
        path,
      });
    }
    return null;
  });
  const parsed = z
    .object({
      session: z.string(),
      isNewUser: z.boolean(),
      error: z.string().optional(),
    })
    .safeParse(data);
  const errorParsed = z.object({ error: z.string().optional() }).safeParse(data);

  if (!response.ok) {
    throw new HttpResponseError(
      errorParsed.success && errorParsed.data.error
        ? errorParsed.data.error
        : "Authentication failed",
      response.status,
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
  const data: unknown = await response.json().catch((error: unknown) => {
    if (!isHttpServerErrorJsonParseFailure(error, response.status)) {
      captureException(error, { source: "password-reset-response-json" });
    }
    return null;
  });
  const parsed = PasswordResetResponseSchema.safeParse(data);
  if (!response.ok) {
    throw new HttpResponseError(
      parsed.success && parsed.data.error ? parsed.data.error : "Password reset failed",
      response.status,
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

  // Exchange the short-lived deep-link code for the session over HTTPS.
  const url = new URL(result.url);
  const code = url.searchParams.get("code");
  if (!code) return null;
  const exchangeResponse = await fetch(`${serverUrl}/auth/mobile/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ code }),
  });
  const exchangeData: unknown = await exchangeResponse.json().catch((error: unknown) => {
    if (!isHttpServerErrorJsonParseFailure(error, exchangeResponse.status)) {
      captureException(error, { source: "mobile-auth-exchange-parse" });
    }
    return null;
  });
  const parsedExchange = z
    .union([z.object({ session: z.string(), isNewUser: z.boolean() }), ErrorResponseSchema])
    .safeParse(exchangeData);
  if (!exchangeResponse.ok || !parsedExchange.success || "error" in parsedExchange.data) {
    const message =
      parsedExchange.success && "error" in parsedExchange.data
        ? parsedExchange.data.error
        : "Authentication failed";
    throw !exchangeResponse.ok
      ? new HttpResponseError(message, exchangeResponse.status)
      : new Error(message);
  }
  return {
    session: parsedExchange.data.session,
    isNewUser: parsedExchange.data.isNewUser,
  };
}

export async function createProviderHandoffCode(
  serverUrl: string,
  providerId: string,
  sessionToken: string,
): Promise<string> {
  const response = await fetch(`${serverUrl}/auth/provider/${providerId}/hand-off`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${sessionToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
  });
  const data: unknown = await response.json().catch((error: unknown) => {
    if (!isHttpServerErrorJsonParseFailure(error, response.status)) {
      captureException(error, { source: "provider-handoff-parse" });
    }
    return null;
  });
  const parsed = z.union([z.object({ code: z.string() }), ErrorResponseSchema]).safeParse(data);
  if (!response.ok || !parsed.success || "error" in parsed.data) {
    const message =
      parsed.success && "error" in parsed.data ? parsed.data.error : "Provider connection failed";
    throw !response.ok ? new HttpResponseError(message, response.status) : new Error(message);
  }
  return parsed.data.code;
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
  const credential = await requestNativeAppleCredential();

  if (!credential?.authorizationCode) {
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
    let text: string;
    try {
      text = await response.text();
    } catch (error: unknown) {
      if (!isHttpServerErrorStatus(response.status)) {
        throw error;
      }
      captureException(error, { source: "apple-native-response-text" });
      throw new HttpResponseError(`Apple Sign In failed: ${response.status}`, response.status);
    }
    throw new HttpResponseError(
      text || `Apple Sign In failed: ${response.status}`,
      response.status,
    );
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
  // Attach rejection handling immediately so a fast local failure cannot become
  // an unhandled rejection while the remote logout request is still in flight.
  const clearLocalSession = clearSessionToken().then(
    () => ({ status: "fulfilled" as const }),
    (reason: unknown) => ({ status: "rejected" as const, reason }),
  );
  try {
    await fetch(`${serverUrl}/auth/logout`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (error: unknown) {
    captureException(error, { source: "logout", retiredLifetime: true });
  }
  const local = await clearLocalSession;
  if (local.status === "rejected") {
    throw local.reason;
  }
}
