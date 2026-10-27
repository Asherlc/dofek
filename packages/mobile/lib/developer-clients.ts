import { createDeveloperClientsApi } from "@dofek/auth/developer-clients";

export function createMobileDeveloperClientsApi({
  serverUrl,
  sessionToken,
}: {
  serverUrl: string;
  sessionToken: string | null;
}) {
  const baseUrl = serverUrl.replace(/\/+$/, "");

  return createDeveloperClientsApi((path, init) => {
    if (!sessionToken) {
      throw new Error("Sign in again to manage developer integrations.");
    }
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${sessionToken}`);
    return fetch(`${baseUrl}${path}`, {
      ...init,
      headers,
    });
  });
}
