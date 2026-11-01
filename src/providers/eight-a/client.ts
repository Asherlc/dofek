import { createHash, randomBytes } from "node:crypto";
import { load } from "cheerio";
import { z } from "zod";
import type { TokenSet } from "../../auth/oauth.ts";
import type { SourceClimbingLogEntry } from "../../db/climbing-log-sync.ts";
import { ProviderAuthError, ProviderInvalidCredentialsError } from "../auth-errors.ts";
import { eightACategories, parseEightAAscentPage } from "./ascent.ts";

const issuer = "https://vlatka.vertical-life.info/auth/realms/Vertical-Life";
const authBase = `${issuer}/protocol/openid-connect`;
const apiBase = "https://vlcapi.vertical-life.info";
const clientId = "vertical-life-ios";
const redirectUri = "vl-climbing://oauth2redirect";
const tokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  scope: z.string().optional(),
});
const identitySchema = z.object({ scim_id: z.string().trim().min(1) });
const profileSchema = z.object({ uuid: z.string().min(1), userSlug: z.string().min(1) });
const reconnect = () =>
  new ProviderAuthError(
    "authentication_failed",
    "Vertical-Life authorization expired or was revoked. Reconnect in Settings → Data Sources.",
  );

export class EightAClient {
  readonly #fetch: typeof globalThis.fetch;
  constructor(fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.#fetch = fetchFn;
  }

  async #json(url: string, init: RequestInit) {
    const response = await this.#fetch(url, init);
    if (response.status === 401 || response.status === 403) throw reconnect();
    if (!response.ok)
      throw new Error(`Vertical-Life request failed (HTTP ${response.status}). Try again.`);
    return response.json();
  }

  async #exchange(
    body: URLSearchParams,
    previous?: TokenSet,
    signal?: AbortSignal,
  ): Promise<TokenSet> {
    const response = await this.#fetch(`${authBase}/token`, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal,
    });
    if ([400, 401, 403].includes(response.status)) throw reconnect();
    if (!response.ok)
      throw new Error(`Vertical-Life authentication failed (HTTP ${response.status}). Try again.`);
    const token = tokenSchema.parse(await response.json());
    // This value comes directly from the trusted issuer's TLS token response, never a submitted JWT.
    let claims: z.infer<typeof identitySchema>;
    try {
      claims = identitySchema.parse(
        JSON.parse(
          Buffer.from(token.access_token.split(".")[1] ?? "", "base64url").toString("utf8"),
        ),
      );
    } catch (error) {
      if (!(error instanceof SyntaxError || error instanceof z.ZodError)) throw error;
      throw new ProviderAuthError(
        "authentication_failed",
        "Vertical-Life returned an invalid credential response. Try reconnecting.",
      );
    }
    if (previous?.providerAccountId && claims.scim_id !== previous.providerAccountId)
      throw new ProviderAuthError(
        "authentication_failed",
        "Vertical-Life refreshed credentials for a different account. Reconnect in Settings → Data Sources.",
      );
    if (!previous) {
      const identity = identitySchema.parse(
        await this.#json(`${authBase}/userinfo`, {
          headers: { Authorization: `Bearer ${token.access_token}` },
        }),
      );
      if (identity.scim_id !== claims.scim_id)
        throw new Error(
          "Vertical-Life returned inconsistent account identities. Try reconnecting.",
        );
    }
    return {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAt: new Date(Date.now() + token.expires_in * 1000),
      providerAccountId: claims.scim_id,
      scopes: token.scope ?? null,
    };
  }

  async login(username: string, password: string): Promise<TokenSet> {
    const verifier = randomBytes(32).toString("base64url");
    const state = randomBytes(24).toString("base64url");
    const url = new URL(`${authBase}/auth`);
    url.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid profile email offline_access",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      state,
    }).toString();
    const page = await this.#fetch(url, { redirect: "manual" });
    if (!page.ok)
      throw new Error(`Vertical-Life login page failed (HTTP ${page.status}). Try again.`);
    const $ = load(await page.text());
    const action = $("#kc-form-login").attr("action");
    if (!action || new URL(action, url).origin !== new URL(issuer).origin)
      throw new Error(
        "Vertical-Life returned an unsupported login form. Sign in on Vertical-Life to check account verification, then try again.",
      );
    const cookies = page.headers
      .getSetCookie()
      .map((cookie) => cookie.split(";")[0])
      .join("; ");
    const result = await this.#fetch(new URL(action, url), {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookies },
      body: new URLSearchParams({ username, password, rememberMe: "on", credentialId: "" }),
    });
    if (result.status === 200 && load(await result.text())("#kc-form-login").length)
      throw new ProviderInvalidCredentialsError("Vertical-Life");
    const location = result.headers.get("location");
    if (result.status !== 302 || !location)
      throw new Error(
        `Vertical-Life login did not complete (HTTP ${result.status}). Sign in on Vertical-Life to check account verification, then try again.`,
      );
    const callback = new URL(location);
    if (
      callback.protocol !== "vl-climbing:" ||
      callback.host !== "oauth2redirect" ||
      callback.searchParams.get("state") !== state
    )
      throw new Error("Vertical-Life login callback state did not match. Try connecting again.");
    const code = callback.searchParams.get("code");
    if (!code)
      throw new Error("Vertical-Life did not authorize this connection. Try connecting again.");
    return this.#exchange(
      new URLSearchParams({
        client_id: clientId,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
        code,
        code_verifier: verifier,
      }),
    );
  }

  async fetchLogbook(
    stored: TokenSet,
    persistTokens: (tokens: TokenSet) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<SourceClimbingLogEntry[]> {
    signal?.throwIfAborted();
    let tokens = stored;
    let refreshed = false;
    const renew = async () => {
      if (!tokens.refreshToken) throw reconnect();
      tokens = await this.#exchange(
        new URLSearchParams({
          client_id: clientId,
          grant_type: "refresh_token",
          refresh_token: tokens.refreshToken,
        }),
        tokens,
        signal,
      );
      await persistTokens(tokens);
      refreshed = true;
    };
    if (tokens.expiresAt.getTime() <= Date.now()) await renew();
    const read = async (url: string): Promise<unknown> => {
      try {
        return await this.#json(url, {
          headers: { Authorization: `Bearer ${tokens.accessToken}` },
          signal,
        });
      } catch (error) {
        if (!(error instanceof ProviderAuthError) || refreshed) throw error;
        await renew();
        return this.#json(url, {
          headers: { Authorization: `Bearer ${tokens.accessToken}` },
          signal,
        });
      }
    };
    if (!tokens.providerAccountId) throw reconnect();
    const profile = profileSchema.parse(
      await read(
        `${apiBase}/profile/v1/web/users/find?${new URLSearchParams({ uuid: tokens.providerAccountId })}`,
      ),
    );
    if (profile.uuid !== tokens.providerAccountId)
      throw new Error(
        "Vertical-Life returned a different logbook owner. Reconnect in Settings → Data Sources.",
      );
    const entries: SourceClimbingLogEntry[] = [];
    const seen = new Set<string>();
    for (const category of eightACategories) {
      for (let pageIndex = 0; ; pageIndex++) {
        signal?.throwIfAborted();
        const query = new URLSearchParams({
          category,
          pageIndex: String(pageIndex),
          pageSize: "50",
          includeProjects: "true",
          showRepeats: "true",
          showDuplicates: "true",
        });
        const page = parseEightAAscentPage(
          await read(
            `${apiBase}/ascent/v1/web/users/${encodeURIComponent(profile.userSlug)}/ascents?${query}`,
          ),
          category,
          pageIndex,
        );
        if (!page.length) break;
        for (const entry of page) {
          if (seen.has(entry.externalId))
            throw new Error(
              "Vertical-Life repeated an ascent during logbook pagination. Try syncing again.",
            );
          seen.add(entry.externalId);
          entries.push(entry);
        }
      }
    }
    return entries;
  }
}
