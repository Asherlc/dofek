export interface AuthUser {
  id: string;
  name: string;
  email: string | null;
}

export type IdentityProviderName = "google" | "apple" | "authentik";

/** Fetch the currently authenticated user, or null if not logged in. */
export async function fetchCurrentUser(): Promise<AuthUser | null> {
  const res = await fetch("/api/auth/me", { credentials: "include" });
  if (!res.ok) return null;
  return res.json();
}

/** Fetch the list of configured identity providers. */
export async function fetchConfiguredProviders(): Promise<IdentityProviderName[]> {
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
