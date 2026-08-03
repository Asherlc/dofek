import { type AuthUser, AuthUserSchema, type ConfiguredProviders } from "@dofek/auth/auth";
import { z } from "zod";
import { captureException } from "./telemetry.ts";
import { withWebAccountStateLockWhenAvailable } from "./web-account-state-lock.ts";

export type { AuthUser, ConfiguredProviders, IdentityProviderName } from "@dofek/auth/auth";

const passwordAuthResponseSchema = z.object({
  session: z.string().optional(),
  redirect: z.string(),
  isNewUser: z.boolean().default(false),
  error: z.string().optional(),
});

const errorResponseSchema = z.object({ error: z.string().min(1) });
const invalidSessionResponseMessage =
  "The server returned an invalid session response. Please try again.";

async function getErrorMessage(response: Response, fallback: string): Promise<string> {
  const data: unknown = await response.json().catch(() => null);
  const parsed = errorResponseSchema.safeParse(data);
  return parsed.success ? parsed.data.error : fallback;
}

export interface PasswordAuthInput {
  email: string;
  password: string;
  name?: string | undefined;
  returnTo?: string | undefined;
}

async function submitPasswordAuth(
  path: "/auth/login/password" | "/auth/register",
  body: Record<string, string | undefined>,
): Promise<{ redirect: string; isNewUser: boolean }> {
  return withWebAccountStateLockWhenAvailable(async () => {
    const res = await fetch(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      credentials: "include",
      body: JSON.stringify(body),
    });

    const data: unknown = await res.json().catch(() => null);
    const parsed = passwordAuthResponseSchema.safeParse(data);
    if (!res.ok) {
      throw new Error(
        parsed.success && parsed.data.error ? parsed.data.error : "Authentication failed",
      );
    }
    if (!parsed.success) {
      throw new Error("Authentication failed");
    }
    return { redirect: parsed.data.redirect, isNewUser: parsed.data.isNewUser };
  });
}

/** Fetch the currently authenticated user, or null if not logged in. */
export async function fetchCurrentUser(): Promise<AuthUser | null> {
  const res = await fetch("/api/auth/me", { credentials: "include" });
  if (res.status === 401 || res.status === 403) return null;
  if (!res.ok) {
    throw new Error(
      await getErrorMessage(res, `Auth bootstrap failed: ${res.status} ${res.statusText}`),
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

/** Fetch the list of configured login providers (identity + data). */
export async function fetchConfiguredProviders(): Promise<ConfiguredProviders> {
  const res = await fetch("/api/auth/providers");
  if (!res.ok) {
    throw new Error(`Failed to fetch providers: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

export async function loginWithPassword(
  input: PasswordAuthInput,
): Promise<{ redirect: string; isNewUser: boolean }> {
  return submitPasswordAuth("/auth/login/password", {
    email: input.email,
    password: input.password,
    return_to: input.returnTo,
  });
}

export async function registerWithPassword(
  input: PasswordAuthInput,
): Promise<{ redirect: string; isNewUser: boolean }> {
  return submitPasswordAuth("/auth/register", {
    email: input.email,
    password: input.password,
    name: input.name,
    return_to: input.returnTo,
  });
}

const resetRequestResponseSchema = z.object({
  error: z.string().optional(),
  message: z.string(),
});

const resetConfirmResponseSchema = z.object({
  error: z.string().optional(),
  ok: z.boolean(),
});

export async function requestPasswordReset(email: string): Promise<{ message: string }> {
  const response = await fetch("/auth/password-reset/request", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ email }),
  });
  const data: unknown = await response.json().catch(() => null);
  const parsed = resetRequestResponseSchema.safeParse(data);
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

export async function confirmPasswordReset(token: string, password: string): Promise<{ ok: true }> {
  const response = await fetch("/auth/password-reset/confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ token, password }),
  });
  const data: unknown = await response.json().catch(() => null);
  const parsed = resetConfirmResponseSchema.safeParse(data);
  if (!response.ok) {
    throw new Error(
      parsed.success && parsed.data.error ? parsed.data.error : "Password reset failed",
    );
  }
  if (!parsed.success || !parsed.data.ok) {
    throw new Error("Password reset failed");
  }
  return { ok: true };
}

/** Log the user out. */
export async function logout(): Promise<void> {
  const response = await fetch("/auth/logout", { method: "POST", credentials: "include" });
  if (!response.ok) {
    throw new Error(
      await getErrorMessage(response, `Logout failed: ${response.status} ${response.statusText}`),
    );
  }
}

export function redirectToLogin(): void {
  window.location.href = "/login";
}
