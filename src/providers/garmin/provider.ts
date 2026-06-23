import { and, eq } from "drizzle-orm";
import { GarminConnectClient, GarminRateLimitError } from "garmin-connect/client";
import type { GarminTokens } from "garmin-connect/types";
import type { TokenSet } from "../../auth/oauth.ts";
import type { SyncDatabase } from "../../db/index.ts";
import { userSettings } from "../../db/schema.ts";
import { getTokenUserId } from "../../db/token-user-context.ts";
import { ensureProvider, loadTokens, saveTokens } from "../../db/tokens.ts";
import { createProviderRateLimitFetch } from "../../lib/provider-rate-limit-fetch.ts";
import { isRetryableInfraError } from "../../lib/retryable-infra-error.ts";
import { logger } from "../../logger.ts";
import type { SyncRun } from "../sync-run.ts";
import type { ProviderAuthSetup, SyncProvider, SyncResult } from "../types.ts";
import { deserializeInternalTokens, serializeInternalTokens } from "./internal-tokens.ts";
import { runGarminOrchestratedSync } from "./sync-orchestrator.ts";

const SYNC_CURSOR_KEY = "garmin_sync_cursor";

function resolveScopedUserId(userId?: string): string {
  const scopedUserId = userId ?? getTokenUserId();
  if (!scopedUserId) {
    throw new Error("garmin sync requires a userId");
  }
  return scopedUserId;
}

async function loadSyncCursor(db: SyncDatabase, userId?: string): Promise<string | null> {
  const scopedUserId = resolveScopedUserId(userId);
  const rows = await db
    .select({ value: userSettings.value })
    .from(userSettings)
    .where(and(eq(userSettings.userId, scopedUserId), eq(userSettings.key, SYNC_CURSOR_KEY)))
    .limit(1);

  if (rows.length === 0 || !rows[0]) return null;
  const value = rows[0].value;
  if (typeof value !== "object" || value === null) return null;
  const cursor = Reflect.get(value, "cursor");
  return typeof cursor === "string" ? cursor : null;
}

async function saveSyncCursor(db: SyncDatabase, cursor: string, userId?: string): Promise<void> {
  const scopedUserId = resolveScopedUserId(userId);
  await db
    .insert(userSettings)
    .values({
      userId: scopedUserId,
      key: SYNC_CURSOR_KEY,
      value: { cursor },
    })
    .onConflictDoUpdate({
      target: [userSettings.userId, userSettings.key],
      set: { value: { cursor }, updatedAt: new Date() },
    });
}

function throwIfProviderSyncAbortError(error: unknown): void {
  if (isRetryableInfraError(error) || error instanceof GarminRateLimitError) throw error;
}

export class GarminProvider implements SyncProvider {
  readonly id = "garmin";
  readonly name = "Garmin Connect";
  #fetchFn: typeof globalThis.fetch;

  constructor(fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.#fetchFn = createProviderRateLimitFetch("garmin", fetchFn, {
      createRateLimitError: (response, responseBody) =>
        new GarminRateLimitError(
          `Rate limit exceeded (${response.status}): ${responseBody}`,
          responseBody,
          response.headers?.get?.("Retry-After"),
        ),
    });
  }

  validate(): string | null {
    return null;
  }

  activityUrl(externalId: string): string {
    return `https://connect.garmin.com/modern/activity/${externalId}`;
  }

  authSetup(_options?: { host?: string }): ProviderAuthSetup {
    return {
      automatedLogin: async (email: string, password: string): Promise<TokenSet> => {
        const { tokens } = await GarminConnectClient.signIn(
          email,
          password,
          "garmin.com",
          this.#fetchFn,
        );
        return serializeInternalTokens(tokens);
      },
    };
  }

  async #resolveTokens(db: SyncDatabase, userId?: string): Promise<GarminTokens> {
    const scopedUserId = resolveScopedUserId(userId);
    const tokens = await loadTokens(db, this.id, scopedUserId);
    if (!tokens) {
      throw new Error("No OAuth tokens found for Garmin. Sign in via the dashboard first.");
    }

    const internalTokens = deserializeInternalTokens(tokens);
    if (!internalTokens) {
      throw new Error(
        "Stored Garmin tokens are not in the expected format. Please sign in again via the dashboard.",
      );
    }

    if (tokens.expiresAt > new Date()) {
      return internalTokens;
    }

    logger.info("[garmin] Internal API token expired, refreshing via OAuth1 exchange...");
    const client = await GarminConnectClient.fromTokens(
      internalTokens,
      "garmin.com",
      this.#fetchFn,
    );
    const refreshed = client.getTokens();
    if (!refreshed) throw new Error("Failed to refresh Garmin Connect tokens");
    await saveTokens(db, this.id, serializeInternalTokens(refreshed), scopedUserId);
    return refreshed;
  }

  async sync(run: SyncRun): Promise<SyncResult> {
    const { db, window, options } = run;
    const start = Date.now();
    const scopedUserId = resolveScopedUserId(options.userId);

    let internalTokens: GarminTokens;
    try {
      internalTokens = await this.#resolveTokens(db, scopedUserId);
    } catch (err) {
      throwIfProviderSyncAbortError(err);
      return {
        provider: this.id,
        recordsSynced: 0,
        errors: [{ message: err instanceof Error ? err.message : String(err), cause: err }],
        duration: Date.now() - start,
        continued: false,
      };
    }

    await ensureProvider(db, this.id, this.name);

    const cursor = await loadSyncCursor(db, scopedUserId);
    const effectiveSince = cursor ? new Date(cursor) : window.since;
    const result = await runGarminOrchestratedSync(
      run,
      internalTokens,
      effectiveSince,
      window.until,
      scopedUserId,
      this.#fetchFn,
      start,
    );

    if (!result.continued) {
      await saveSyncCursor(db, window.until.toISOString(), scopedUserId);
    }

    return result;
  }
}
