import type { AuthUser, ConfiguredProviders } from "@dofek/auth/auth";

export type { AuthUser, ConfiguredProviders, IdentityProviderName } from "@dofek/auth/auth";

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

/** Log the user out. */
export async function logout(): Promise<void> {
  await fetch("/auth/logout", { method: "POST", credentials: "include" });
  window.location.href = "/login";
}
