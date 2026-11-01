import { z } from "zod";
import type { TokenSet } from "../../auth/oauth.ts";
import { ProviderAuthError, ProviderInvalidCredentialsError } from "../auth-errors.ts";

const baseUrl = "https://api.crimpd.com";
const tokenResponse = z.object({
  success: z.literal(true),
  user: z.object({ _id: z.string().trim().min(1) }),
  token: z.string().trim().min(1),
  refreshToken: z.string().trim().min(1),
  expiresIn: z.number().int().positive(),
});

function reconnect(): ProviderAuthError {
  return new ProviderAuthError(
    "authentication_failed",
    "Crimpd authorization expired or was revoked. Reconnect in Settings → Data Sources.",
  );
}

/** Contracts observed in https://my.crimpd.com/main.3bcc34bf74e9df68.js. */
export class CrimpdClient {
  readonly #fetch: typeof globalThis.fetch;

  constructor(fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.#fetch = fetchFn;
  }

  async #exchange(
    path: string,
    body: Record<string, string>,
    previous?: TokenSet,
  ): Promise<TokenSet> {
    const response = await this.#fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if ([400, 401, 403].includes(response.status))
      throw previous ? reconnect() : new ProviderInvalidCredentialsError("Crimpd");
    if (!response.ok)
      throw new Error(`Crimpd authentication request failed (HTTP ${response.status}). Try again.`);
    const parsed = tokenResponse.safeParse(await response.json());
    if (!parsed.success)
      throw new Error("Crimpd returned an invalid authentication response. Try reconnecting.", {
        cause: parsed.error,
      });
    const data = parsed.data;
    if (previous?.providerAccountId && previous.providerAccountId !== data.user._id)
      throw new ProviderAuthError(
        "authentication_failed",
        "Crimpd refreshed credentials for a different account. Reconnect in Settings → Data Sources.",
      );
    return {
      accessToken: data.token,
      refreshToken: data.refreshToken,
      expiresAt: new Date(Date.now() + data.expiresIn * 1000),
      providerAccountId: data.user._id,
      scopes: null,
    };
  }

  login(username: string, password: string): Promise<TokenSet> {
    return this.#exchange("/auth/jwt", { username, password });
  }

  refresh(tokens: TokenSet): Promise<TokenSet> {
    if (!tokens.refreshToken) return Promise.reject(reconnect());
    return this.#exchange("/auth/refresh", { refreshToken: tokens.refreshToken }, tokens);
  }

  async downloadExport(tokens: TokenSet, signal?: AbortSignal): Promise<Uint8Array> {
    const response = await this.#fetch(`${baseUrl}/analytics/export?format=zip`, {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
      signal,
    });
    if ([401, 403].includes(response.status)) throw reconnect();
    if (!response.ok)
      throw new Error(`Crimpd logbook export failed (HTTP ${response.status}). Try syncing again.`);
    if (response.headers.get("content-type")?.split(";")[0]?.trim() !== "application/zip")
      throw new Error("Crimpd did not return a ZIP logbook export. Try syncing again.");
    return new Uint8Array(await response.arrayBuffer());
  }
}
