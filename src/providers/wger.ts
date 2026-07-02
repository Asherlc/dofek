import type { CanonicalActivityType } from "@dofek/training/training";
import type { OAuthConfig, TokenSet } from "../auth/oauth.ts";
import { exchangeCodeForTokens, getOAuthRedirectUri } from "../auth/oauth.ts";
import { resolveOAuthTokens } from "../auth/resolve-tokens.ts";
import type { SyncDatabase } from "../db/index.ts";
import { writeMetricStreamBatch } from "../db/metric-stream-writer.ts";
import {
  finishProviderActivityListSync,
  upsertProviderActivity,
} from "../db/provider-activity-sync.ts";
import { SOURCE_TYPE_API } from "../db/sensor-channels.ts";
import { withSyncLog } from "../db/sync-log.ts";
import { ensureProvider } from "../db/tokens.ts";
import { createProviderRateLimitFetch } from "../lib/provider-rate-limit-fetch.ts";
import { fetchProviderPages } from "../sync/pagination.ts";
import type { SyncRun } from "./sync-run.ts";
import type { ProviderAuthSetup, SyncError, SyncProvider, SyncResult } from "./types.ts";

// ============================================================
// Wger API types
// ============================================================

const WGER_API_BASE = "https://wger.de/api/v2";
const _DEFAULT_REDIRECT_URI = "https://localhost:9876/callback";

interface WgerWorkoutSession {
  id: number;
  date: string; // YYYY-MM-DD
  comment: string;
  impression: string; // e.g. "1" = general, "2" = neutral, etc.
  time_start: string | null;
  time_end: string | null;
}

interface WgerWeightEntry {
  id: number;
  date: string; // YYYY-MM-DD
  weight: string; // decimal as string
}

interface WgerPaginatedResponse<T> {
  count: number;
  next: string | null;
  previous: string | null;
  results: T[];
}

// ============================================================
// Parsed types
// ============================================================

export interface ParsedWgerWorkoutSession {
  externalId: string;
  activityType: CanonicalActivityType;
  name: string;
  startedAt: Date;
  raw: Record<string, unknown>;
}

export interface ParsedWgerWeightEntry {
  externalId: string;
  recordedAt: Date;
  weightKg: number;
}

// ============================================================
// Pure parsing functions (exported for testing)
// ============================================================

export function parseWgerWorkoutSession(session: WgerWorkoutSession): ParsedWgerWorkoutSession {
  return {
    externalId: String(session.id),
    activityType: "strength",
    name: session.comment || "Workout",
    startedAt: new Date(session.date),
    raw: {
      comment: session.comment,
      impression: session.impression,
      timeStart: session.time_start,
      timeEnd: session.time_end,
    },
  };
}

export function parseWgerWeightEntry(entry: WgerWeightEntry): ParsedWgerWeightEntry {
  return {
    externalId: String(entry.id),
    recordedAt: new Date(entry.date),
    weightKg: Number.parseFloat(entry.weight),
  };
}

// ============================================================
// OAuth configuration
// ============================================================

export function wgerOAuthConfig(host?: string): OAuthConfig | null {
  const clientId = process.env.WGER_CLIENT_ID;
  const clientSecret = process.env.WGER_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  return {
    clientId,
    clientSecret,
    authorizeUrl: "https://wger.de/en/user/authorize",
    tokenUrl: "https://wger.de/api/v2/token",
    redirectUri: getOAuthRedirectUri(host),
    scopes: ["read"],
  };
}

// ============================================================
// Provider implementation
// ============================================================

export class WgerProvider implements SyncProvider {
  readonly id = "wger";
  readonly name = "Wger";
  #fetchFn: typeof globalThis.fetch;

  constructor(fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.#fetchFn = createProviderRateLimitFetch("wger", fetchFn);
  }

  validate(): string | null {
    if (!process.env.WGER_CLIENT_ID) return "WGER_CLIENT_ID is not set";
    if (!process.env.WGER_CLIENT_SECRET) return "WGER_CLIENT_SECRET is not set";
    return null;
  }

  authSetup(options?: { host?: string }): ProviderAuthSetup {
    const config = wgerOAuthConfig(options?.host);
    if (!config) throw new Error("WGER_CLIENT_ID and CLIENT_SECRET required");
    const fetchFn = this.#fetchFn;
    return {
      oauthConfig: config,
      exchangeCode: (code) => exchangeCodeForTokens(config, code, fetchFn),
      apiBaseUrl: WGER_API_BASE,
    };
  }

  async #resolveTokens(db: SyncDatabase): Promise<TokenSet> {
    return resolveOAuthTokens({
      db,
      providerId: this.id,
      providerName: this.name,
      getOAuthConfig: () => wgerOAuthConfig(),
      fetchFn: this.#fetchFn,
    });
  }

  async sync(run: SyncRun): Promise<SyncResult> {
    const { db, window, options } = run;
    const start = Date.now();
    const errors: SyncError[] = [];
    let recordsSynced = 0;

    await ensureProvider(db, this.id, this.name, WGER_API_BASE);

    let accessToken: string;
    try {
      const tokens = await this.#resolveTokens(db);
      accessToken = tokens.accessToken;
    } catch (err) {
      errors.push({ message: err instanceof Error ? err.message : String(err), cause: err });
      return { provider: this.id, recordsSynced, errors, duration: Date.now() - start };
    }

    // Sync workout sessions → activity table
    const since = window.since;
    const syncWindowEnd = window.until;
    const presentActivityExternalIds = new Set<string>();
    try {
      const activityCount = await withSyncLog(
        db,
        this.id,
        "activity",
        async () => {
          let count = 0;
          const initialUrl = `${WGER_API_BASE}/workoutsession/?format=json&ordering=-date&offset=0&limit=50`;

          const pages = await fetchProviderPages<WgerWorkoutSession, string>({
            providerId: this.id,
            stepName: "activity",
            initialCursor: initialUrl,
            fetchPage: async (url) => {
              if (!url) throw new Error("Wger workout pagination missing page URL");
              const response = await this.#fetchFn(url, {
                headers: {
                  Authorization: `Bearer ${accessToken}`,
                  Accept: "application/json",
                },
              });
              if (!response.ok) {
                const text = await response.text();
                throw new Error(`Wger API error (${response.status}): ${text}`);
              }
              const data: WgerPaginatedResponse<WgerWorkoutSession> = await response.json();
              return {
                items: data.results ?? [],
                nextCursor: data.next,
              };
            },
            shouldStopAfterPage: (page) =>
              page.items.some((session) => new Date(session.date) < since),
          });

          for (const raw of pages.items) {
            const sessionDate = new Date(raw.date);
            if (sessionDate < since || sessionDate >= syncWindowEnd) {
              continue;
            }

            const parsed = parseWgerWorkoutSession(raw);
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
                  raw: parsed.raw,
                },
                {
                  activityType: parsed.activityType,
                  name: parsed.name,
                  startedAt: parsed.startedAt,
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

          if (pages.degradations.length === 0) {
            await finishProviderActivityListSync(db, {
              providerId: this.id,
              userId: options?.userId,
              windowStart: since,
              windowEnd: syncWindowEnd,
              presentExternalIds: presentActivityExternalIds,
            });
          }
          return { recordCount: count, result: count, degradations: pages.degradations };
        },
        options?.userId,
      );
      recordsSynced += activityCount;
    } catch (err) {
      errors.push({
        message: `activity: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }

    // Sync body weight into metric stream body channels.
    try {
      const weightCount = await withSyncLog(
        db,
        this.id,
        "metric_stream",
        async () => {
          let count = 0;
          const initialUrl = `${WGER_API_BASE}/weightentry/?format=json&ordering=-date&offset=0&limit=50`;

          const pages = await fetchProviderPages<WgerWeightEntry, string>({
            providerId: this.id,
            stepName: "metric_stream",
            initialCursor: initialUrl,
            fetchPage: async (url) => {
              if (!url) throw new Error("Wger weight pagination missing page URL");
              const response = await this.#fetchFn(url, {
                headers: {
                  Authorization: `Bearer ${accessToken}`,
                  Accept: "application/json",
                },
              });
              if (!response.ok) {
                const text = await response.text();
                throw new Error(`Wger API error (${response.status}): ${text}`);
              }
              const data: WgerPaginatedResponse<WgerWeightEntry> = await response.json();
              return {
                items: data.results ?? [],
                nextCursor: data.next,
              };
            },
            shouldStopAfterPage: (page) => page.items.some((entry) => new Date(entry.date) < since),
          });

          for (const raw of pages.items) {
            const entryDate = new Date(raw.date);
            if (entryDate < since || entryDate >= syncWindowEnd) {
              continue;
            }

            const parsed = parseWgerWeightEntry(raw);
            try {
              await writeMetricStreamBatch(
                db,
                [
                  {
                    providerId: this.id,
                    externalId: parsed.externalId,
                    recordedAt: parsed.recordedAt,
                    weightKg: parsed.weightKg,
                  },
                ],
                SOURCE_TYPE_API,
                undefined,
                options?.metricStreamPublisher,
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

          return { recordCount: count, result: count, degradations: pages.degradations };
        },
        options?.userId,
      );
      recordsSynced += weightCount;
    } catch (err) {
      errors.push({
        message: `metric_stream: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }

    return { provider: this.id, recordsSynced, errors, duration: Date.now() - start };
  }
}
