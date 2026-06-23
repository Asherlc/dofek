import type { AuthUser, ConfiguredProviders } from "@dofek/auth/auth";
import { z } from "zod";

export type { AuthUser, ConfiguredProviders, IdentityProviderName } from "@dofek/auth/auth";

const passwordAuthResponseSchema = z.object({
  session: z.string().optional(),
  redirect: z.string(),
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
): Promise<{ redirect: string }> {
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
  return { redirect: parsed.data.redirect };
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

export async function loginWithPassword(input: PasswordAuthInput): Promise<{ redirect: string }> {
  return submitPasswordAuth("/auth/login/password", {
    email: input.email,
    password: input.password,
    return_to: input.returnTo,
  });
}

export async function registerWithPassword(
  input: PasswordAuthInput,
): Promise<{ redirect: string }> {
  return submitPasswordAuth("/auth/register", {
    email: input.email,
    password: input.password,
    name: input.name,
    return_to: input.returnTo,
  });
}

/** Log the user out. */
export async function logout(): Promise<void> {
  await fetch("/auth/logout", { method: "POST", credentials: "include" });
  window.location.href = "/login";
}
