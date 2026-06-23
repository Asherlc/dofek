import type { AuthUser, ConfiguredProviders } from "@dofek/auth/auth";
import { z } from "zod";

export type { AuthUser, ConfiguredProviders, IdentityProviderName } from "@dofek/auth/auth";

const passwordAuthResponseSchema = z.object({
  session: z.string().optional(),
  redirect: z.string(),
  isNewUser: z.boolean().default(false),
  error: z.string().optional(),
});

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
}

/** Fetch the currently authenticated user, or null if not logged in. */
export async function fetchCurrentUser(): Promise<AuthUser | null> {
  const res = await fetch("/api/auth/me", { credentials: "include" });
  if (!res.ok) return null;
  return res.json();
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
  await fetch("/auth/logout", { method: "POST", credentials: "include" });
  window.location.href = "/login";
}
