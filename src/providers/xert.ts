import {
  DEFAULT_XERT_CLIENT_CREDENTIALS,
  signInToXert,
  XERT_API_BASE_URL,
  XertClient,
} from "@dofek/xert/client";
import { mapXertSport, type ParsedXertActivity, parseXertActivity } from "@dofek/xert/parsing";
import type { XertActivity, XertClientCredentials } from "@dofek/xert/types";
import type { OAuthConfig, TokenSet } from "../auth/oauth.ts";
import { getOAuthRedirectUri } from "../auth/oauth.ts";
import { resolveOAuthTokens } from "../auth/resolve-tokens.ts";
import type { SyncDatabase } from "../db/index.ts";
import {
  finishProviderActivityListSync,
  upsertProviderActivity,
} from "../db/provider-activity-sync.ts";
import { PartialSyncError, withSyncLog } from "../db/sync-log.ts";
import { ensureProvider } from "../db/tokens.ts";
import { createProviderRateLimitFetch } from "../lib/provider-rate-limit-fetch.ts";
import { fetchProviderPages } from "../sync/pagination.ts";
import type { SyncDegradation } from "../sync/sync-degradation.ts";
import type { SyncRun } from "./sync-run.ts";
import type { ProviderAuthSetup, SyncError, SyncProvider, SyncResult } from "./types.ts";

export { mapXertSport, parseXertActivity, signInToXert };
export type { ParsedXertActivity };

const XERT_API_BASE = XERT_API_BASE_URL;

function xertClientCredentials(): XertClientCredentials {
  return {
    clientId: process.env.XERT_CLIENT_ID ?? DEFAULT_XERT_CLIENT_CREDENTIALS.clientId,
    clientSecret: process.env.XERT_CLIENT_SECRET ?? DEFAULT_XERT_CLIENT_CREDENTIALS.clientSecret,
  };
}

// ============================================================
// OAuth configuration (used for token refresh)
// ============================================================

export function xertOAuthConfig(host?: string): OAuthConfig | null {
  const { clientId, clientSecret } = xertClientCredentials();

  return {
    clientId,
    clientSecret,
    authorizeUrl: `${XERT_API_BASE}/oauth/authorize`,
    tokenUrl: `${XERT_API_BASE}/oauth/token`,
    redirectUri: getOAuthRedirectUri(host),
    scopes: [],
    tokenAuthMethod: "basic",
  };
}

// ============================================================
// Provider implementation
// ============================================================

export class XertProvider implements SyncProvider {
  readonly id = "xert";
  readonly name = "Xert";
  #fetchFn: typeof globalThis.fetch;

  constructor(fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.#fetchFn = createProviderRateLimitFetch("xert", fetchFn);
  }

  validate(): string | null {
    // Xert uses public client credentials by default, so no env vars strictly required.
    // But we still need OAuth tokens to have been obtained via the auth flow.
    return null;
  }

  activityUrl(externalId: string): string {
    return `https://www.xertonline.com/activities/${externalId}`;
  }

  authSetup(options?: { host?: string }): ProviderAuthSetup {
    const config = xertOAuthConfig(options?.host);
    if (!config) throw new Error("Failed to create Xert OAuth config");
    const fetchFn = this.#fetchFn;
    return {
      oauthConfig: config,
      automatedLogin: (email, password) =>
        signInToXert(email, password, fetchFn, xertClientCredentials()),
      exchangeCode: async () => {
        throw new Error("Xert uses automated login, not OAuth code exchange");
      },
      apiBaseUrl: XERT_API_BASE,
    };
  }

  async #resolveTokens(db: SyncDatabase): Promise<TokenSet> {
    return resolveOAuthTokens({
      db,
      providerId: this.id,
      providerName: this.name,
      getOAuthConfig: () => xertOAuthConfig(),
      fetchFn: this.#fetchFn,
    });
  }

  async sync(run: SyncRun): Promise<SyncResult> {
    const { db, window, options } = run;
    const start = Date.now();
    const errors: SyncError[] = [];
    let recordsSynced = 0;

    await ensureProvider(db, this.id, this.name, XERT_API_BASE);

    let client: XertClient;
    try {
      const tokens = await this.#resolveTokens(db);
      client = new XertClient(tokens.accessToken, this.#fetchFn);
    } catch (err) {
      errors.push({ message: err instanceof Error ? err.message : String(err), cause: err });
      return { provider: this.id, recordsSynced, errors, duration: Date.now() - start };
    }

    const since = window.since;
    const syncWindowEnd = window.until;
    const presentActivityExternalIds = new Set<string>();
    const degradations: SyncDegradation[] = [];
    try {
      const activityCount = await withSyncLog(
        db,
        this.id,
        "activity",
        async () => {
          let count = 0;
          const pageSize = 50;

          try {
            const pages = await fetchProviderPages<XertActivity, number>({
              providerId: this.id,
              stepName: "activity_list",
              initialCursor: 0,
              fetchPage: async (page) => {
                const currentPage = page ?? 0;
                const data = await client.listActivities({
                  from: Math.floor(since.getTime() / 1000),
                  page: currentPage,
                  limit: pageSize,
                });
                return {
                  items: data,
                  nextCursor: data.length >= pageSize ? currentPage + 1 : null,
                };
              },
              onPage: async (page) => {
                for (const rawActivity of page.items) {
                  const parsed = parseXertActivity(rawActivity);
                  if (parsed.startedAt < since || parsed.startedAt >= syncWindowEnd) {
                    continue;
                  }
                  presentActivityExternalIds.add(parsed.externalId);
                  try {
                    await upsertProviderActivity(
                      db,
                      {
                        providerId: this.id,
                        externalId: parsed.externalId,
                        activityType: parsed.activityType,
                        name: parsed.name,
                        startedAt: parsed.startedAt,
                        endedAt: parsed.endedAt,
                        raw: parsed.raw,
                      },
                      {
                        activityType: parsed.activityType,
                        name: parsed.name,
                        startedAt: parsed.startedAt,
                        endedAt: parsed.endedAt,
                        raw: parsed.raw,
                      },
                    );
                    count++;
                  } catch (err) {
                    errors.push({
                      message: err instanceof Error ? err.message : String(err),
                      externalId: parsed.externalId,
                      cause: err,
                    });
                  }
                }
              },
            });
            degradations.push(...pages.degradations);
          } catch (err) {
            throw new PartialSyncError(
              `activity: ${err instanceof Error ? err.message : String(err)}`,
              count,
              err,
            );
          }

          if (degradations.length === 0) {
            await finishProviderActivityListSync(db, {
              providerId: this.id,
              userId: options?.userId,
              windowStart: since,
              windowEnd: syncWindowEnd,
              presentExternalIds: presentActivityExternalIds,
            });
          }
          return { recordCount: count, result: count, degradations };
        },
        options?.userId,
      );
      recordsSynced += activityCount;
    } catch (err) {
      if (err instanceof PartialSyncError) {
        recordsSynced += err.recordCount;
      }
      errors.push({
        message: err instanceof Error ? err.message : String(err),
        cause: err instanceof PartialSyncError ? err.cause : err,
      });
    }

    return { provider: this.id, recordsSynced, errors, degradations, duration: Date.now() - start };
  }
}
