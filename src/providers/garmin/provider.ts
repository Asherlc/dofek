import { GarminConnectClient, GarminRateLimitError } from "@dofek/garmin-connect/client";
import type { GarminTokens } from "@dofek/garmin-connect/types";
import { and, eq } from "drizzle-orm";
import type { TokenSet } from "../../auth/oauth.ts";
import type { SyncDatabase } from "../../db/index.ts";
import { userSettings } from "../../db/schema/account.ts";
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

const OAUTH_CONSUMER_HOST = "thegarth.s3.amazonaws.com";

function resolveRequestUrl(input: RequestInfo | URL): URL | null {
  try {
    if (input instanceof URL) {
      return input;
    }
    if (typeof input === "string") {
      return new URL(input);
    }
    if (input instanceof Request) {
      return new URL(input.url);
    }
    return new URL(String(input));
  } catch {
    return null;
  }
}

function isGarminOAuthConsumerRequest(input: RequestInfo | URL): boolean {
  const url = resolveRequestUrl(input);
  return url?.hostname === OAUTH_CONSUMER_HOST;
}

/** Routes static OAuth consumer fetches around adaptive rate limiting. */
function createGarminConnectFetch(
  baseFetchFn: typeof globalThis.fetch,
  rateLimitedFetchFn: typeof globalThis.fetch,
): typeof globalThis.fetch {
  return async (input, init) => {
    if (isGarminOAuthConsumerRequest(input)) {
      return init === undefined ? baseFetchFn(input) : baseFetchFn(input, init);
    }
    return init === undefined ? rateLimitedFetchFn(input) : rateLimitedFetchFn(input, init);
  };
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
        const authFetch = createGarminConnectFetch(
          this.#baseFetchFn,
          createProviderRateLimitFetch("garmin", this.#baseFetchFn, {
            createRateLimitError: (response, responseBody) =>
              new GarminRateLimitError(
                `Rate limit exceeded (${response.status}): ${responseBody}`,
                responseBody,
                response.headers?.get?.("Retry-After"),
              ),
          }),
        );
        const { tokens } = await GarminConnectClient.signIn(
          email,
          password,
          "garmin.com",
          authFetch,
        );
        return serializeInternalTokens(tokens);
      },
    };
  }

  async #resolveTokens(
    db: SyncDatabase,
    fetchFn: typeof globalThis.fetch,
    userId?: string,
  ): Promise<GarminTokens> {
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
    const client = await GarminConnectClient.fromTokens(internalTokens, "garmin.com", fetchFn);
    const refreshed = client.getTokens();
    if (!refreshed) throw new Error("Failed to refresh Garmin Connect tokens");
    await saveTokens(db, this.id, serializeInternalTokens(refreshed), scopedUserId);
    return refreshed;
  }

  async sync(run: SyncRun): Promise<SyncResult> {
    const { db, window, options } = run;
    const start = Date.now();
    const scopedUserId = resolveScopedUserId(options.userId);

    // Garmin's unofficial Connect API rate-limits by egress IP, not per account.
    // Use provider-scoped admission so concurrent users share one throttle budget.
    const fetchFn = createGarminConnectFetch(
      this.#baseFetchFn,
      createProviderRateLimitFetch("garmin", this.#baseFetchFn, {
        createRateLimitError: (response, responseBody) =>
          new GarminRateLimitError(
            `Rate limit exceeded (${response.status}): ${responseBody}`,
            responseBody,
            response.headers?.get?.("Retry-After"),
          ),
      }),
    );

    let internalTokens: GarminTokens;
    try {
      internalTokens = await this.#resolveTokens(db, fetchFn, scopedUserId);
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
      fetchFn,
      start,
    );

    if (!result.continued) {
      await saveSyncCursor(db, window.until.toISOString(), scopedUserId);
    }

    return result;
  }
}
