import { z } from "zod";
import type { OAuthConfig } from "../../auth/oauth.ts";
import { exchangeCodeForTokens, getOAuthRedirectUri } from "../../auth/oauth.ts";
import { ensureProvider } from "../../db/tokens.ts";
import { createProviderRateLimitFetch } from "../../lib/provider-rate-limit-fetch.ts";
import type { SyncRun } from "../sync-run.ts";
import type { ProviderAuthSetup, ProviderIdentity, SyncProvider, SyncResult } from "../types.ts";
import { runWhoopOrchestratedSync } from "./sync-orchestrator.ts";

// ============================================================
// Provider implementation
// ============================================================

export class WhoopProvider implements SyncProvider {
  readonly id = "whoop";
  readonly name = "WHOOP";
  readonly scheduledSyncLookbackDays = 30;
  #fetchFn: typeof globalThis.fetch;

  constructor(fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.#fetchFn = createProviderRateLimitFetch("whoop", fetchFn);
  }

  validate(): string | null {
    // WHOOP is always "enabled" — auth state is checked at sync time via stored tokens
    return null;
  }

  /**
   * Returns OAuth setup for login via Whoop.
   * Returns undefined if WHOOP_CLIENT_ID or WHOOP_CLIENT_SECRET are not set.
   * Whoop supports OAuth for login, but data sync can continue using Cognito tokens.
   */
  authSetup(options?: { host?: string }): ProviderAuthSetup | undefined {
    const clientId = process.env.WHOOP_CLIENT_ID;
    const clientSecret = process.env.WHOOP_CLIENT_SECRET;
    if (!clientId || !clientSecret) return undefined;

    const config: OAuthConfig = {
      clientId,
      clientSecret,
      authorizeUrl: "https://api.prod.whoop.com/oauth/oauth2/auth",
      tokenUrl: "https://api.prod.whoop.com/oauth/oauth2/token",
      redirectUri: getOAuthRedirectUri(options?.host),
      scopes: ["read:profile"],
    };
    const fetchFn = this.#fetchFn;

    return {
      oauthConfig: config,
      exchangeCode: (code) => exchangeCodeForTokens(config, code, fetchFn),
      getUserIdentity: async (accessToken: string): Promise<ProviderIdentity> => {
        const response = await fetchFn(
          "https://api.prod.whoop.com/developer/v2/user/profile/basic",
          { headers: { Authorization: `Bearer ${accessToken}` } },
        );
        if (!response.ok) {
          const text = await response.text();
          throw new Error(`Whoop profile API error (${response.status}): ${text}`);
        }
        const whoopProfileSchema = z.object({
          user_id: z.number(),
          email: z.string().nullish(),
          first_name: z.string().nullish(),
          last_name: z.string().nullish(),
        });
        const data = whoopProfileSchema.parse(await response.json());
        const nameParts = [data.first_name, data.last_name].filter(Boolean);
        return {
          providerAccountId: String(data.user_id),
          email: data.email ?? null,
          name: nameParts.length > 0 ? nameParts.join(" ") : null,
        };
      },
    };
  }

  async sync(run: SyncRun): Promise<SyncResult> {
    const start = Date.now();
    await ensureProvider(run.db, this.id, this.name, undefined, run.options.userId);
    return runWhoopOrchestratedSync(run, this.#fetchFn, start);
  }
}
