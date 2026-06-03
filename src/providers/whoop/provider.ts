import { createRateLimitAwareFetch } from "@dofek/provider-http/rate-limit";
import { WhoopClient } from "whoop-whoop/client";
import type { WhoopCycle } from "whoop-whoop/types";
import { z } from "zod";
import type { OAuthConfig } from "../../auth/oauth.ts";
import { exchangeCodeForTokens, getOAuthRedirectUri } from "../../auth/oauth.ts";
import type { SyncDatabase } from "../../db/index.ts";
import { ensureProvider, loadTokens, saveTokens } from "../../db/tokens.ts";
import { logger } from "../../logger.ts";
import { ProviderStoredIdentityMissingError } from "../auth-errors.ts";
import type {
  ProviderAuthSetup,
  ProviderIdentity,
  SyncError,
  SyncOptions,
  SyncProvider,
  SyncResult,
} from "../types.ts";
import { syncWhoopDailyActivity } from "./sync-daily-activity.ts";
import { syncWhoopJournal } from "./sync-journal.ts";
import { syncWhoopRecovery } from "./sync-recovery.ts";
import { syncWhoopSleepSessions, syncWhoopSleepStages } from "./sync-sleep.ts";
import { syncWhoopHeartRateStream } from "./sync-streams.ts";
import type { WhoopSyncContext } from "./sync-types.ts";
import { syncWhoopStrength, syncWhoopWorkouts } from "./sync-workouts.ts";

// ============================================================
// Provider implementation
// ============================================================

export class WhoopProvider implements SyncProvider {
  readonly id = "whoop";
  readonly name = "WHOOP";
  #fetchFn: typeof globalThis.fetch;

  constructor(fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.#fetchFn = createRateLimitAwareFetch(fetchFn, { providerId: "whoop" });
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

  async sync(db: SyncDatabase, since: Date, options?: SyncOptions): Promise<SyncResult> {
    const start = Date.now();
    const errors: SyncError[] = [];
    let recordsSynced = 0;

    await ensureProvider(db, this.id, this.name);

    let client: WhoopClient;
    try {
      // Try loading stored tokens from DB
      const stored = await loadTokens(db, this.id);
      if (!stored?.refreshToken) {
        throw new Error("WHOOP not connected — authenticate via the web UI");
      }

      // Extract stored userId from scopes (saved as "userId:12345" during auth)
      const storedUserIdMatch = stored.scopes?.match(/userId:(\d+)/);
      const storedUserId = storedUserIdMatch ? Number(storedUserIdMatch[1]) : null;

      // Refresh the access token using the stored refresh token
      const token = await WhoopClient.refreshAccessToken(stored.refreshToken, this.#fetchFn);

      // Use the stored userId if available, otherwise use the one from bootstrap
      const userId = storedUserId ?? token.userId;
      if (!userId) {
        throw new ProviderStoredIdentityMissingError("WHOOP", "user ID");
      }

      // Save the refreshed tokens back to DB, preserving the userId in scopes
      const scopes = `userId:${userId}`;
      await saveTokens(db, this.id, {
        accessToken: token.accessToken,
        refreshToken: token.refreshToken,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // assume ~24h expiry
        scopes,
      });

      client = new WhoopClient(
        { accessToken: token.accessToken, refreshToken: token.refreshToken, userId },
        this.#fetchFn,
        (event) => {
          const logMethod = event.status === 429 ? "warn" : "info";
          logger[logMethod]("[whoop] API request", {
            whoopUserId: event.userId,
            endpoint: event.endpoint,
            status: event.status,
            attempt: event.attempt,
            retryAfterSeconds: event.retryAfterSeconds,
            timestamp: event.timestamp.toISOString(),
          });
        },
      );
    } catch (err) {
      errors.push({ message: err instanceof Error ? err.message : String(err), cause: err });
      return { provider: this.id, recordsSynced, errors, duration: Date.now() - start };
    }

    // --- Fetch all cycles (recovery + sleep + workouts embedded) ---
    // WHOOP API limits cycle queries to 200-day windows
    const MAX_CYCLE_WINDOW_MS = 200 * 24 * 60 * 60 * 1000;
    const cycles: WhoopCycle[] = [];
    try {
      let windowStart = since.getTime();
      const nowMs = Date.now();
      while (windowStart < nowMs) {
        const windowEnd = Math.min(windowStart + MAX_CYCLE_WINDOW_MS, nowMs);
        const startStr = new Date(windowStart).toISOString();
        const endStr = new Date(windowEnd).toISOString();
        logger.info(`[whoop] Fetching cycles ${startStr} → ${endStr}`);
        const chunk = await client.getCycles(startStr, endStr);
        cycles.push(...chunk);
        windowStart = windowEnd;
      }
      logger.info(`[whoop] Fetched ${cycles.length} total cycles`);
    } catch (err) {
      errors.push({
        message: `getCycles: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
      return { provider: this.id, recordsSynced, errors, duration: Date.now() - start };
    }

    const context: WhoopSyncContext = {
      db,
      client,
      cycles,
      providerId: this.id,
      since,
      options,
      errors,
    };

    recordsSynced += await syncWhoopRecovery(context);

    const dailyActivityResult = await syncWhoopDailyActivity(context);
    recordsSynced += dailyActivityResult.count;
    let rateLimited = dailyActivityResult.rateLimited;

    recordsSynced += await syncWhoopSleepSessions(context);
    recordsSynced += await syncWhoopSleepStages(context);
    recordsSynced += await syncWhoopWorkouts(context);

    const strengthResult = await syncWhoopStrength(context);
    recordsSynced += strengthResult.count;
    rateLimited ||= strengthResult.rateLimited;

    if (!rateLimited) {
      const heartRateResult = await syncWhoopHeartRateStream(context);
      recordsSynced += heartRateResult.count;
      rateLimited ||= heartRateResult.rateLimited;
    }

    if (!rateLimited) {
      recordsSynced += await syncWhoopJournal(context);
    }

    return {
      provider: this.id,
      recordsSynced,
      errors,
      duration: Date.now() - start,
    };
  }
}
