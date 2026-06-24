import { and, eq } from "drizzle-orm";
import { GarminConnectClient, GarminRateLimitError } from "garmin-connect/client";
import type { GarminTokens } from "garmin-connect/types";
import type { TokenSet } from "../../auth/oauth.ts";
import type { SyncDatabase } from "../../db/index.ts";
import { userSettings } from "../../db/schema.ts";
import { ensureProvider, loadTokens, saveTokens } from "../../db/tokens.ts";
import { createProviderRateLimitFetch } from "../../lib/provider-rate-limit-fetch.ts";
import { isRetryableInfraError } from "../../lib/retryable-infra-error.ts";
import { resolveScopedUserId } from "../../lib/user-context.ts";
import { logger } from "../../logger.ts";
import type { SyncRun } from "../sync-run.ts";
import type { ProviderAuthSetup, SyncProvider, SyncResult } from "../types.ts";
import { deserializeInternalTokens, serializeInternalTokens } from "./internal-tokens.ts";
import { runGarminOrchestratedSync } from "./sync-orchestrator.ts";

const SYNC_CURSOR_KEY = "garmin_sync_cursor";

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
  if (typeof cursor !== "string") return null;
  if (Number.isNaN(new Date(cursor).getTime())) return null;
  return cursor;
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
  #baseFetchFn: typeof globalThis.fetch;

  constructor(fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.#baseFetchFn = fetchFn;
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
          this.#baseFetchFn,
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
      this.#baseFetchFn,
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

    const fetchFn = createProviderRateLimitFetch("garmin", this.#baseFetchFn, {
      scope: "user",
      userId: scopedUserId,
      createRateLimitError: (response, responseBody) =>
        new GarminRateLimitError(
          `Rate limit exceeded (${response.status}): ${responseBody}`,
          responseBody,
          response.headers?.get?.("Retry-After"),
          scopedUserId,
        ),
    });

    const cursor = await loadSyncCursor(db, scopedUserId);
    const effectiveSince = cursor ? new Date(cursor) : window.since;
    const result = await runGarminOrchestratedSync(
      run,
      internalTokens,
      effectiveSince,
      window.until,
      scopedUserId,
      fetchFn,
      start,
    );

    if (!result.continued) {
      await saveSyncCursor(db, window.until.toISOString(), scopedUserId);
    }

    return result;
  }
}
